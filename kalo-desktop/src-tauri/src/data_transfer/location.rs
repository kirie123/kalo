//! Whole-profile relocation. The small home-level locator is the commit point.
use super::{location_copy as copy, location_links as links, platform, types::Progress};
use crate::kalo_home::{self, Location};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

const REQUEST: &str = "transfers/location-request.json";
const OWNER: &str = ".kalo-relocation-owner";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root: PathBuf,
    pub target: Option<PathBuf>,
    pub backup: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    id: String,
    source: PathBuf,
    target: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
}

fn journal_path(home: &Path) -> PathBuf {
    home.join(".kalo-relocation.json")
}
pub fn pending(home: &Path) -> bool {
    exists(&journal_path(home))
}

pub fn lock(home: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join(".kalo-location.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "另一个 Kalo 正在运行，请先关闭它后重试".to_string())?;
    Ok(file)
}

pub fn status(root: &Path, home: &Path) -> Result<Status, String> {
    Ok(Status {
        root: root.into(),
        target: request(root)?,
        backup: kalo_home::read_location(home)?.map(|l| l.backup),
    })
}

fn request(root: &Path) -> Result<Option<PathBuf>, String> {
    match fs::read(root.join(REQUEST)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("迁移请求损坏，请取消后重新选择目录：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn destination(source: &Path, parent: &Path) -> Result<PathBuf, String> {
    if !parent.is_absolute() || !parent.is_dir() {
        return Err("请选择一个已存在的绝对路径文件夹".into());
    }
    let source = links::canonical(source).map_err(|e| e.to_string())?;
    let parent = links::canonical(parent).map_err(|e| e.to_string())?;
    let target = parent.join(".kalo");
    if target == source || target.starts_with(&source) || source.starts_with(&target) {
        return Err("目标不能是当前数据目录，也不能与当前目录互相包含".into());
    }
    if exists(&target) {
        return Err(format!(
            "目标已存在：{}。请选择不含 .kalo 的文件夹，不会覆盖现有数据",
            target.display()
        ));
    }
    #[cfg(windows)]
    if parent.to_string_lossy().starts_with(r"\\") {
        return Err("请选择本机磁盘；Windows 的旧路径兼容入口不支持网络共享".into());
    }
    Ok(target)
}

pub fn prepare(root: &Path, parent: Option<&Path>) -> Result<(), String> {
    if let Some(parent) = parent {
        let target = destination(root, parent)?;
        platform::atomic_write(
            &root.join(REQUEST),
            &serde_json::to_vec(&target).map_err(|e| e.to_string())?,
        )?;
        platform::atomic_write(&root.join("transfers/maintenance"), b"1")?;
    } else if root.join(REQUEST).exists() {
        fs::remove_file(root.join(REQUEST)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_journal(j: &Journal) -> Result<(), String> {
    uuid::Uuid::parse_str(&j.id).map_err(|_| "迁移恢复记录编号无效")?;
    if !j.source.is_absolute()
        || !j.target.is_absolute()
        || j.target.file_name() != Some(std::ffi::OsStr::new(".kalo"))
        || j.stage
            != j.target
                .parent()
                .ok_or("缺少目标父目录")?
                .join(format!(".kalo-moving-{}", j.id))
        || j.backup
            != j.source
                .parent()
                .ok_or("缺少源父目录")?
                .join(format!(".kalo-backup-{}", j.id))
        || j.target.starts_with(&j.source)
        || j.source.starts_with(&j.target)
    {
        return Err("迁移恢复记录路径无效，请保留现场并检查 .kalo-relocation.json".into());
    }
    Ok(())
}

/// Recover before resolving/caching the root or taking its profile lock.
pub fn recover(home: &Path) -> Result<(), String> {
    let bytes = match fs::read(journal_path(home)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let j: Journal =
        serde_json::from_slice(&bytes).map_err(|e| format!("迁移恢复记录损坏：{e}"))?;
    validate_journal(&j)?;
    let committed = kalo_home::read_location(home)?.is_some_and(|l| l.root == j.target);
    if committed {
        if !j.target.is_dir() {
            return Err(format!(
                "新数据磁盘不可用，请重新连接 {} 后启动",
                j.target.display()
            ));
        }
        if !exists(&j.source) {
            links::alias(&j.target, &j.source).map_err(|e| format!("无法恢复旧路径入口：{e}"))?;
        }
        // A crash inside Windows junction creation/deletion may leave an empty directory.
        // Only remove an empty directory; stop if another program placed content here.
        if links::link_target(&j.source)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            fs::remove_dir(&j.source)
                .map_err(|e| format!("旧路径被其他内容占用，请保留现场：{e}"))?;
            links::alias(&j.target, &j.source).map_err(|e| e.to_string())?;
        }
        if fs::canonicalize(&j.source).map_err(|e| e.to_string())?
            != fs::canonicalize(&j.target).map_err(|e| e.to_string())?
        {
            return Err("旧路径入口被其他文件占用，请保留现场并处理后重启".into());
        }
    } else {
        if exists(&j.backup) {
            if exists(&j.source) {
                if links::link_target(&j.source)
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    links::remove_alias(&j.source, &j.target)?;
                } else {
                    fs::remove_dir(&j.source)
                        .map_err(|e| format!("原位置被其他内容占用，停止恢复：{e}"))?;
                }
            }
            links::rename_new(&j.backup, &j.source)
                .map_err(|e| format!("无法恢复原目录，请关闭占用文件的程序：{e}"))?;
            platform::sync_parent(&j.source)?;
        }
        if !j.source.is_dir() {
            return Err("原数据目录丢失，请保留迁移日志和备份，恢复磁盘后重试".into());
        }
        if exists(&j.target) {
            if fs::read_to_string(j.target.join(OWNER)).ok().as_deref() != Some(&j.id)
                || exists(&j.stage)
            {
                return Err("目标目录归属不明，停止恢复以保护数据，请保留迁移日志和备份".into());
            }
            links::rename_new(&j.target, &j.stage).map_err(|e| format!("无法移回迁移副本：{e}"))?;
            platform::sync_parent(&j.stage)?;
        }
    }
    // Keep verified staging/backup bytes for inspection. Never recursively delete user data.
    fs::remove_file(journal_path(home)).map_err(|e| e.to_string())?;
    platform::sync_parent(&journal_path(home))
}

pub fn relocate(
    root: &Path,
    home: &Path,
    progress: &impl Fn(Progress),
    before_move: impl FnOnce() -> Result<(), String>,
) -> Result<Location, String> {
    if pending(home) {
        return Err("有未恢复的目录迁移，请关闭 Kalo 后重新启动以恢复".into());
    }
    let requested = request(root)?.ok_or("请先在设置中选择目标文件夹")?;
    let source = links::canonical(root).map_err(|e| e.to_string())?;
    let target = destination(&source, requested.parent().ok_or("目标路径无效")?)?;
    let user_home = links::canonical(home).map_err(|e| e.to_string())?;
    if user_home.starts_with(&source) || user_home.starts_with(&target) {
        return Err("数据根不能包含用户主目录，请使用独立的 .kalo 子目录".into());
    }
    let entries = copy::inventory(&source, progress)?;
    let bytes = entries
        .values()
        .filter_map(|e| {
            if let copy::Entry::File(n, _) = e {
                Some(*n)
            } else {
                None
            }
        })
        .try_fold(0u64, |a, b| a.checked_add(b))
        .ok_or("数据总量超过可处理范围")?;
    platform::require_space(target.parent().unwrap(), bytes)?;
    let id = uuid::Uuid::new_v4().to_string();
    let j = Journal {
        stage: target.parent().unwrap().join(format!(".kalo-moving-{id}")),
        backup: source
            .parent()
            .ok_or("源目录不能是磁盘根")?
            .join(format!(".kalo-backup-{id}")),
        id,
        source,
        target,
    };
    validate_journal(&j)?;
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
        .create(&j.stage)
        .map_err(|e| format!("无法创建目标暂存目录：{e}"))?;
    if let Err(error) = copy::copy(&j.source, &j.stage, &entries, progress) {
        return Err(format!(
            "{error}。未完成副本保留在 {}，原数据未切换",
            j.stage.display()
        ));
    }
    platform::write_new(&j.stage.join(OWNER), j.id.as_bytes())?;
    platform::atomic_write(
        &journal_path(home),
        &serde_json::to_vec(&j).map_err(|e| e.to_string())?,
    )?;
    let mut aliases = kalo_home::read_location(home)?
        .map(|l| l.aliases)
        .unwrap_or_default();
    if !aliases.contains(&j.source) {
        aliases.push(j.source.clone());
    }
    let location = Location {
        version: 1,
        root: j.target.clone(),
        backup: j.backup.clone(),
        aliases,
    };
    let result = (|| {
        links::rename_new(&j.stage, &j.target).map_err(|e| e.to_string())?;
        platform::sync_parent(&j.target)?;
        let _destination_lock = platform::profile_lock(&j.target)?;
        before_move()?;
        links::rename_new(&j.source, &j.backup)
            .map_err(|e| format!("无法移动原目录，请关闭占用文件的程序：{e}"))?;
        platform::sync_parent(&j.backup)?;
        links::alias(&j.target, &j.source).map_err(|e| format!("无法建立旧路径兼容入口：{e}"))?;
        platform::sync_parent(&j.source)?;
        platform::atomic_write(
            &kalo_home::location_file(home),
            &serde_json::to_vec_pretty(&location).map_err(|e| e.to_string())?,
        )
    })();
    let committed = kalo_home::read_location(home)?.is_some_and(|l| l.root == j.target);
    // A sync failure after replacing the locator must not undo an already committed root.
    recover(home)?;
    if committed {
        Ok(location)
    } else {
        Err(format!(
            "{}；已恢复原位置，副本保留在 {}",
            result.err().unwrap_or_else(|| "未保存新数据位置".into()),
            j.stage.display()
        ))
    }
}

#[cfg(test)]
#[path = "location_tests.rs"]
mod tests;
