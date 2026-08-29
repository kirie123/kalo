//! Digital expert registry (`~/.kalo/experts.json`).
//!
//! An expert is a long-lived agent identity bound to a working directory:
//! its sessions run with `cwd = workdir`, its skills live in
//! `<workdir>/.kalo/skills/` (project-scope, loaded by the engine natively),
//! and its memory lives in `<workdir>/.kalo/memory/` (injected via the
//! `KALO_MEMORY_DIR` env var at spawn, keeping it physically isolated from
//! the user's own `~/.kalo/memory/`).
//!
//! Design: doc/2026-08-29-digital-experts.md. The registry file is data, not
//! code: the expert-designer skill edits it directly; the Tauri commands here
//! serve the desktop experts panel and session spawning.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expert {
    /// `[\w-]{1,64}`, unique, stable.
    pub id: String,
    pub name: String,
    /// Absolute path; must exist at upsert time.
    pub workdir: String,
    pub mission: String,
    pub created_at: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Everything a session spawn needs to become this expert.
#[derive(Debug, Clone)]
pub struct ExpertCtx {
    pub id: String,
    pub name: String,
    pub mission: String,
    /// `<workdir>/.kalo/memory` — the expert's isolated memory root.
    pub memory_dir: PathBuf,
}

impl Expert {
    pub fn ctx(&self) -> ExpertCtx {
        ExpertCtx {
            id: self.id.clone(),
            name: self.name.clone(),
            mission: self.mission.clone(),
            memory_dir: Path::new(&self.workdir).join(".kalo").join("memory"),
        }
    }
}

/// `~/.kalo/experts.json`
fn registry_file() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("experts.json"))
}

fn validate(expert: &Expert) -> Result<(), String> {
    let id = expert.id.trim();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("专家 id 只能是 1-64 位字母数字/-/_：{:?}", expert.id));
    }
    if expert.name.trim().is_empty() {
        return Err("专家名称不能为空".to_string());
    }
    if !Path::new(&expert.workdir).is_dir() {
        return Err(format!("专家工作目录不存在：{}", expert.workdir));
    }
    Ok(())
}

fn load_from(path: &Path) -> Result<Vec<Expert>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取 experts.json 失败：{e}"))?;
    #[derive(Deserialize)]
    struct Registry {
        #[serde(default)]
        experts: Vec<Expert>,
    }
    let registry: Registry =
        serde_json::from_str(&text).map_err(|e| format!("解析 experts.json 失败：{e}"))?;
    Ok(registry.experts)
}

/// Atomic write: tmp file + rename, same convention as the scheduler store.
fn save_to(path: &Path, experts: &[Expert]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    }
    let body = serde_json::json!({ "experts": experts });
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败：{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换 experts.json 失败：{e}"))?;
    Ok(())
}

pub fn list() -> Result<Vec<Expert>, String> {
    load_from(&registry_file()?)
}

pub fn find(id: &str) -> Option<Expert> {
    list().ok()?.into_iter().find(|e| e.id == id && e.enabled)
}

#[tauri::command(async)]
pub fn expert_list() -> Result<Vec<Expert>, String> {
    list()
}

#[tauri::command(async)]
pub fn expert_upsert(expert: Expert) -> Result<(), String> {
    validate(&expert)?;
    let path = registry_file()?;
    let mut experts = load_from(&path)?;
    match experts.iter_mut().find(|e| e.id == expert.id) {
        Some(existing) => *existing = expert,
        None => experts.push(expert),
    }
    save_to(&path, &experts)
}

#[tauri::command(async)]
pub fn expert_remove(id: String) -> Result<(), String> {
    let path = registry_file()?;
    let mut experts = load_from(&path)?;
    let before = experts.len();
    experts.retain(|e| e.id != id);
    if experts.len() == before {
        return Err(format!("专家不存在：{id}"));
    }
    save_to(&path, &experts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> Expert {
        Expert {
            id: id.to_string(),
            name: "测试专家".to_string(),
            workdir: std::env::temp_dir().to_string_lossy().to_string(),
            mission: "测试".to_string(),
            created_at: "2026-08-29".to_string(),
            enabled: true,
        }
    }

    #[test]
    fn roundtrip_load_save() {
        let dir = std::env::temp_dir().join(format!("kalo-experts-test-{}", std::process::id()));
        let path = dir.join("experts.json");
        let _ = fs::remove_dir_all(&dir);
        assert!(load_from(&path).unwrap().is_empty());
        save_to(&path, &[sample("a"), sample("b")]).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "a");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_rejects_bad_id_and_missing_dir() {
        let mut e = sample("bad id!");
        assert!(validate(&e).is_err());
        e = sample("ok-id");
        e.workdir = "Z:/no/such/dir-9f3b".to_string();
        assert!(validate(&e).is_err());
        e = sample("ok-id");
        assert!(validate(&e).is_ok());
    }

    #[test]
    fn ctx_memory_dir_is_under_workdir() {
        let e = sample("x");
        let ctx = e.ctx();
        assert!(ctx.memory_dir.ends_with(Path::new(".kalo").join("memory")));
    }
}
