//! Streaming copies and verification, without traversing links.
use super::{location_links, types::Progress};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub enum Entry {
    Dir,
    File(u64, String),
    Link(PathBuf),
}
pub type Inventory = BTreeMap<PathBuf, Entry>;

fn ignored(path: &Path) -> bool {
    [
        "profile.lock",
        ".kalo-relocation-owner",
        "transfers/maintenance",
        "transfers/location-request.json",
    ]
    .iter()
    .any(|p| path == Path::new(p))
}

fn hash(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes += count as u64;
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

pub fn inventory(root: &Path, progress: &impl Fn(Progress)) -> Result<Inventory, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        entries: &mut Inventory,
        progress: &impl Fn(Progress),
    ) -> Result<(), String> {
        for item in fs::read_dir(dir).map_err(|e| format!("无法扫描 {}：{e}", dir.display()))?
        {
            let path = item.map_err(|e| e.to_string())?.path();
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            if ignored(&rel) {
                continue;
            }
            let entry = if let Some(target) = location_links::link_target(&path)
                .map_err(|e| format!("无法读取链接 {}：{e}", path.display()))?
            {
                Entry::Link(target)
            } else {
                super::platform::no_link(&path)?;
                if path.is_dir() {
                    Entry::Dir
                } else {
                    let (size, digest) = hash(&path)?;
                    Entry::File(size, digest)
                }
            };
            let is_dir = entry == Entry::Dir;
            entries.insert(rel, entry);
            if entries.len() % 64 == 0 {
                progress(Progress {
                    phase: "正在扫描并校验数据".into(),
                    completed: entries.len(),
                    total: entries.len(),
                });
            }
            if is_dir {
                walk(root, &path, entries, progress)?;
            }
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    progress(Progress {
        phase: "正在扫描并校验数据".into(),
        completed: 0,
        total: 0,
    });
    walk(root, root, &mut entries, progress)?;
    Ok(entries)
}

pub fn copy(
    source: &Path,
    stage: &Path,
    entries: &Inventory,
    progress: &impl Fn(Progress),
) -> Result<(), String> {
    for (i, (rel, entry)) in entries.iter().enumerate() {
        let from = source.join(rel);
        let to = stage.join(rel);
        let result = match entry {
            Entry::Dir => fs::create_dir(&to),
            Entry::Link(target) => location_links::copy_link(&from, &to, target),
            Entry::File(_, _) => (|| {
                let output = OpenOptions::new().write(true).create_new(true).open(&to)?;
                // Keep a writable handle for FlushFileBuffers on Windows, including read-only files.
                fs::copy(&from, &to)?;
                output.sync_all()
            })(),
        };
        result
            .map_err(|e| format!("无法复制 {}：{e}。请检查权限和目标磁盘格式", from.display()))?;
        super::platform::sync_parent(&to)?;
        if i % 64 == 0 || i + 1 == entries.len() {
            progress(Progress {
                phase: "正在复制数据".into(),
                completed: i + 1,
                total: entries.len(),
            });
        }
    }
    // Set directory permissions last, so read-only parents do not prevent copying children.
    for (rel, entry) in entries.iter().rev() {
        if *entry == Entry::Dir {
            fs::set_permissions(
                stage.join(rel),
                fs::metadata(source.join(rel))
                    .map_err(|e| e.to_string())?
                    .permissions(),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    fs::set_permissions(
        stage,
        fs::metadata(source)
            .map_err(|e| e.to_string())?
            .permissions(),
    )
    .map_err(|e| e.to_string())?;
    if inventory(stage, progress)? != *entries || inventory(source, progress)? != *entries {
        return Err(
            "复制校验失败或源数据被其他程序修改；请暂停外部写入后重试，原目录未改变".into(),
        );
    }
    Ok(())
}
