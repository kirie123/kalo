//! Digital expert registry (`~/.kalo/experts.json`).
//!
//! Expert definitions are separate from each task's working directory.
//! Skills and memory live under the definition directory (legacy `workdir`
//! remains a read fallback). Memory is injected via the
//! `KALO_MEMORY_DIR` env var at spawn, keeping it physically isolated from
//! user's own `~/.kalo/memory/`.
//!
//! Design: doc/2026-08-29-digital-experts.md. The registry file is data, not
//! code: the expert-designer skill edits it directly; the Tauri commands here
//! serve the desktop experts panel and session spawning.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expert {
    /// `[\w-]{1,64}`, unique, stable.
    pub id: String,
    pub name: String,
    /// Legacy definition location; never used as a task cwd.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workdir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_dir: Option<String>,
    pub mission: String,
    pub created_at: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<ExpertMember>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertMember {
    pub id: String,
    pub name: String,
    pub profession: String,
    pub agent_path: String,
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
    pub definition_dir: PathBuf,
    /// `<workdir>/.kalo/memory` — the expert's isolated memory root.
    pub memory_dir: PathBuf,
}

impl Expert {
    pub fn definition_dir(&self) -> PathBuf {
        PathBuf::from(self.definition_dir.as_deref().unwrap_or(&self.workdir))
    }

    pub fn contains_definition_path(&self, path: &Path) -> bool {
        match (self.definition_dir().canonicalize(), path.canonicalize()) {
            (Ok(root), Ok(candidate)) => candidate.starts_with(root),
            _ => false,
        }
    }

    pub fn ctx(&self) -> ExpertCtx {
        ExpertCtx {
            id: self.id.clone(),
            name: self.name.clone(),
            mission: self.mission.clone(),
            definition_dir: self.definition_dir(),
            memory_dir: self.definition_dir().join(".kalo").join("memory"),
        }
    }
}

impl ExpertCtx {
    pub fn configure_command(&self, cmd: &mut std::process::Command) {
        cmd.env("KALO_EXPERT_ID", &self.id)
            .env("KALO_EXPERT_NAME", &self.name)
            .env("KALO_EXPERT_MISSION", &self.mission)
            .env("KALO_EXPERT_DIR", &self.definition_dir)
            .env("KALO_MEMORY_DIR", &self.memory_dir);
        let skills = self.definition_dir.join(".kalo").join("skills");
        if skills.is_dir() { cmd.arg("--skill").arg(skills); }
    }
}

/// `~/.kalo/experts.json`
pub(crate) fn registry_file() -> Result<PathBuf, String> {
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
    if !expert.definition_dir().is_dir() {
        return Err(format!("专家定义目录不存在：{}", expert.definition_dir().display()));
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

fn session_expert(reader: impl BufRead, experts: &[Expert]) -> Result<Option<String>, String> {
    let mut legacy_cwd = None;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("读取会话身份失败：{e}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
        if value["type"] == "session" { legacy_cwd = value["cwd"].as_str().map(String::from); }
        if value["type"] == "custom" && value["customType"] == "kalo-expert-context" {
            return Ok(value["data"]["id"].as_str().map(String::from));
        }
        if value["type"] == "message" && value["message"]["role"] == "assistant" { break; }
    }
    Ok(legacy_cwd.and_then(|cwd| experts.iter()
        .find(|expert| expert.entry_agent.is_some() && expert.definition_dir() == PathBuf::from(&cwd))
        .map(|expert| expert.id.clone())))
}

#[tauri::command(async)]
pub fn expert_for_session(path: String) -> Result<Option<String>, String> {
    let file = fs::File::open(&path).map_err(|e| format!("读取会话身份失败：{e}"))?;
    session_expert(BufReader::new(file), &list()?)
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
            definition_dir: None,
            mission: "测试".to_string(),
            created_at: "2026-08-29".to_string(),
            enabled: true,
            kind: None,
            entry_agent: None,
            members: Vec::new(),
            package_version: None,
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

    #[test]
    fn legacy_registry_entry_needs_no_migration() {
        let expert: Expert = serde_json::from_value(serde_json::json!({
            "id": "legacy", "name": "原专家", "workdir": "/tmp/legacy",
            "mission": "保持原行为", "createdAt": "2026-08-29"
        })).unwrap();
        assert!(expert.enabled);
        assert!(expert.kind.is_none());
        assert!(expert.members.is_empty());
    }

    #[test]
    fn explicit_definition_dir_wins_without_changing_task_cwd() {
        let mut expert = sample("selected");
        expert.definition_dir = Some(std::env::temp_dir().join("expert definition").to_string_lossy().into_owned());
        let task = std::env::temp_dir().join("task output");
        let mut cmd = std::process::Command::new("test-engine");
        cmd.current_dir(&task);
        expert.ctx().configure_command(&mut cmd);
        assert_eq!(cmd.get_current_dir(), Some(task.as_path()));
        assert!(expert.ctx().memory_dir.starts_with(expert.definition_dir()));
        assert!(cmd.get_envs().any(|(key, value)| key == "KALO_EXPERT_DIR" && value == Some(expert.definition_dir().as_os_str())));
    }

    #[test]
    fn restores_identity_before_first_assistant_and_ignores_later_tool_content() {
        let log = "{\"type\":\"session\",\"cwd\":\"/tasks/a\"}\n{\"type\":\"custom\",\"customType\":\"kalo-expert-context\",\"data\":{\"id\":\"editor\"}}\n{\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}\n";
        assert_eq!(session_expert(log.as_bytes(), &[]).unwrap().as_deref(), Some("editor"));
        let ordinary = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}\n{\"type\":\"custom\",\"customType\":\"kalo-expert-context\",\"data\":{\"id\":\"wrong\"}}\n";
        assert!(session_expert(ordinary.as_bytes(), &[]).unwrap().is_none());
    }
}
