//! Process-wide data-root contract. Project-local `.kalo` directories are separate.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub version: u32,
    pub root: PathBuf,
    pub backup: PathBuf,
    #[serde(default)]
    pub aliases: Vec<PathBuf>,
}

impl Location {
    /// Map only recorded former roots; the caller still applies its normal containment checks.
    pub fn remap_reference(&self, path: &Path) -> Option<PathBuf> {
        self.aliases
            .iter()
            .find_map(|alias| path.strip_prefix(alias).ok().map(|rel| self.root.join(rel)))
    }
}

pub fn location_file(home: &Path) -> PathBuf {
    home.join(".kalo-location.json")
}

pub fn read_location(home: &Path) -> Result<Option<Location>, String> {
    let path = location_file(home);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法读取数据位置 {}：{e}", path.display())),
    };
    let location: Location = serde_json::from_slice(&bytes)
        .map_err(|e| format!("数据位置配置损坏，请检查 {}：{e}", path.display()))?;
    if location.version != 1
        || !location.root.is_absolute()
        || !location.backup.is_absolute()
        || location.aliases.iter().any(|p| !p.is_absolute())
    {
        return Err(format!("数据位置配置无效，请检查 {}", path.display()));
    }
    Ok(Some(location))
}

pub fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定用户目录，请设置 USERPROFILE 或 HOME".into())
}

fn resolve_root(configured: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    let root = match configured.filter(|p| !p.as_os_str().is_empty()) {
        Some(path) => path.to_path_buf(),
        None => home
            .ok_or("无法确定用户目录，请设置 KALO_HOME 为绝对路径")?
            .join(".kalo"),
    };
    if !root.is_absolute() {
        return Err(
            "KALO_HOME 必须是完整的绝对路径（例如所选目录下的 .kalo），修改后重启应用".into(),
        );
    }
    Ok(root)
}

pub fn root() -> Result<PathBuf, String> {
    ROOT.get_or_init(|| {
        let home = user_home()?;
        let configured = std::env::var_os("KALO_HOME").map(PathBuf::from);
        startup_root(&home, configured.as_deref())
    })
    .clone()
}

pub(crate) fn startup_root(home: &Path, configured: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(location) = read_location(home)? {
        if !location.root.is_dir() {
            return Err(format!(
                "数据目录不可用：{}。请连接对应磁盘后重试；位置记录在 {}",
                location.root.display(),
                location_file(home).display()
            ));
        }
        return Ok(location.root);
    }
    resolve_root(configured, Some(home))
}

pub fn configure_command(command: &mut std::process::Command) -> Result<(), String> {
    command.env("KALO_HOME", root()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_root_is_the_root_not_its_parent() {
        let home = std::env::temp_dir().join("home");
        let custom = std::env::temp_dir().join("中文 data").join(".kalo");
        assert_eq!(resolve_root(Some(&custom), Some(&home)).unwrap(), custom);
        assert_eq!(resolve_root(Some(&custom), None).unwrap(), custom);
        assert_eq!(resolve_root(None, Some(&home)).unwrap(), home.join(".kalo"));
        assert_eq!(
            resolve_root(Some(Path::new("")), Some(&home)).unwrap(),
            home.join(".kalo")
        );
        assert!(resolve_root(Some(Path::new("relative/.kalo")), Some(&home)).is_err());
        assert!(resolve_root(None, None).is_err());
    }
}
