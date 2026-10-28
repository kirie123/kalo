//! Filesystem boundary shared by normal startup and the transfer workspace.
use super::types::{TransferResult, MAX_FILE};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

pub fn root() -> TransferResult<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法找到用户目录".to_string())?;
    if !Path::new(&home).is_absolute() {
        return Err("用户目录必须是有效绝对路径".into());
    }
    Ok(PathBuf::from(home).join(".kalo"))
}

pub fn key(path: &str) -> String {
    path.nfc().case_fold().collect()
}

pub fn validate(path: &str) -> TransferResult<()> {
    if path.is_empty() || path.len() > 2048 || path.split('/').count() > 64 || path.contains('\\') {
        return Err(format!("不是可移植的相对路径：{path}"));
    }
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_uppercase();
        if part.is_empty()
            || part.len() > 255
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            )
            || ["COM", "LPT"].iter().any(|p| {
                stem.strip_prefix(p).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            })
        {
            return Err(format!("文件名无法在 Windows 与 macOS 间迁移：{path}"));
        }
    }
    Ok(())
}

pub fn no_link(path: &Path) -> TransferResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            let special = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let special = false;
            if meta.file_type().is_symlink() || special || (!meta.is_dir() && !meta.is_file()) {
                return Err(format!("不支持链接或特殊文件：{}", path.display()));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("无法检查 {}：{e}", path.display())),
    }
}

pub fn safe(root: &Path, rel: &str) -> TransferResult<PathBuf> {
    validate(rel)?;
    no_link(root)?;
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        out.push(part);
        no_link(&out)?;
    }
    Ok(out)
}

pub fn target(root: &Path, rel: &str) -> TransferResult<PathBuf> {
    safe(root, rel)?;
    let mut parent = root.to_path_buf();
    for part in rel.split('/') {
        if parent.is_dir() {
            for entry in fs::read_dir(&parent).map_err(|e| e.to_string())? {
                let name = entry
                    .map_err(|e| e.to_string())?
                    .file_name()
                    .to_string_lossy()
                    .into_owned();
                if name != part && key(&name) == key(part) {
                    return Err(format!(
                        "本机存在大小写或 Unicode 重名，请先改名后重试：{rel}（{name}）"
                    ));
                }
            }
        }
        parent.push(part);
    }
    Ok(parent)
}

/// Resolve local references without following links. A reference may contain `..`, an archive entry may not.
pub fn resolve(root: &Path, document: &str, reference: &str) -> TransferResult<PathBuf> {
    if reference.starts_with("//") || reference.starts_with("\\\\") {
        return Err("网络文件请先复制到个人附件目录".into());
    }
    let reference = reference.replace('\\', "/");
    let input = Path::new(&reference);
    let joined = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(document)
            .parent()
            .ok_or("笔记没有父目录")?
            .join(input)
    };
    let mut normalized = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("引用越界".into());
                }
            }
            Component::CurDir => {}
            _ => normalized.push(c.as_os_str()),
        }
    }
    let rel = normalized
        .strip_prefix(root)
        .map_err(|_| "引用位于个人数据目录之外，请先复制到 ~/.kalo/attachments/".to_string())?;
    safe(root, &rel.to_string_lossy().replace('\\', "/"))
}

pub fn read(path: &Path, limit: u64) -> TransferResult<Vec<u8>> {
    no_link(path)?;
    let mut f = File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    if !f.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("只支持普通文件".into());
    }
    let mut data = Vec::new();
    (&mut f)
        .take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > limit {
        return Err(format!("文件超过大小限制：{}", path.display()));
    }
    Ok(data)
}

pub fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
pub fn file_hash(path: &Path) -> TransferResult<Option<String>> {
    no_link(path)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(hash(&read(path, MAX_FILE)?)))
}

pub fn sync_parent(path: &Path) -> TransferResult<()> {
    #[cfg(unix)]
    File::open(path.parent().ok_or("缺少父目录")?)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn write_new(path: &Path, bytes: &[u8]) -> TransferResult<()> {
    no_link(path)?;
    let parent = path.parent().ok_or("缺少父目录")?;
    create_dirs(parent)?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("无法新建 {}：{e}", path.display()))?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("写入失败：{e}"))?;
    sync_parent(path)
}

/// Persist each newly introduced directory entry as well as file contents on Unix.
pub fn create_dirs(path: &Path) -> TransferResult<()> {
    no_link(path)?;
    if path.is_dir() {
        return Ok(());
    }
    let parent = path.parent().ok_or("缺少父目录")?;
    create_dirs(parent)?;
    match fs::create_dir(path) {
        Ok(()) => sync_parent(path),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => no_link(path),
        Err(e) => Err(format!("无法创建目录 {}：{e}", path.display())),
    }
}

/// The temp is on the destination volume. Windows uses std's replacement rename; a sharing violation is an error.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> TransferResult<()> {
    let name = format!(".kalo-transfer-{}.tmp", uuid::Uuid::new_v4());
    let tmp = path.parent().ok_or("缺少父目录")?.join(name);
    write_new(&tmp, bytes)?;
    no_link(path)?;
    let result = fs::rename(&tmp, path)
        .map_err(|e| format!("无法替换 {}（请关闭占用文件的程序）：{e}", path.display()));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    sync_parent(path)
}

pub fn profile_lock(root: &Path) -> TransferResult<File> {
    no_link(root)?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = safe(root, "profile.lock")?;
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.try_lock_exclusive()
        .map_err(|_| "另一个 Kalo 正在使用此数据目录，请先退出后再启动".to_string())?;
    Ok(f)
}

pub fn require_space(path: &Path, bytes: u64) -> TransferResult<()> {
    if fs2::available_space(path).map_err(|e| e.to_string())?
        < bytes.saturating_add(64 * 1024 * 1024)
    {
        Err("磁盘空间不足，请释放空间后重试".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_cross_platform_escapes() {
        for p in [
            "../x",
            "/x",
            "C:/x",
            "a\\b",
            "a//b",
            "a/CON.txt",
            "a/x.",
            "a/x ",
            "a/x:y",
            "a/COM¹.txt",
        ] {
            assert!(validate(p).is_err(), "{p}");
        }
        assert!(validate("knowledge/中文/学习 笔记.md").is_ok());
        assert_eq!(key("A/É.md"), key("a/E\u{301}.md"));
        assert_eq!(key("STRASSE.md"), key("straße.md"));
    }
}
