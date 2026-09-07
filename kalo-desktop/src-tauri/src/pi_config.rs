//! Read/write helpers for the pi engine's own configuration files:
//! `~/.kalo/agent/models.json` (custom providers) and `~/.kalo/agent/auth.json`
//! (API keys). The engine reads both at process start, so changes take
//! effect for newly spawned sessions.

use std::fs;
use std::path::PathBuf;

fn agent_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("agent"))
}

fn read_json_file(path: &PathBuf, fallback: &str) -> Result<serde_json::Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("failed to parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            serde_json::from_str(fallback).map_err(|e| e.to_string())
        }
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

fn write_json_file(path: &PathBuf, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Read ~/.kalo/agent/models.json; returns `{"providers":{}}` when absent.
pub fn read_models_config() -> Result<serde_json::Value, String> {
    read_json_file(&agent_dir()?.join("models.json"), r#"{"providers":{}}"#)
}

/// Write ~/.kalo/agent/models.json.
pub fn write_models_config(config: &serde_json::Value) -> Result<(), String> {
    write_json_file(&agent_dir()?.join("models.json"), config)
}

/// Read ~/.kalo/agent/auth.json; returns `{}` when absent.
pub fn read_auth_config() -> Result<serde_json::Value, String> {
    read_json_file(&agent_dir()?.join("auth.json"), "{}")
}

/// Write ~/.kalo/agent/auth.json.
pub fn write_auth_config(config: &serde_json::Value) -> Result<(), String> {
    write_json_file(&agent_dir()?.join("auth.json"), config)
}

const PERMISSION_MODES: [&str; 3] = ["read-only", "workspace-write", "full-auto"];

/// Read `defaultPermissionMode` from ~/.kalo/agent/settings.json.
///
/// The engine reads this only when a session is created, so it is the default
/// for FUTURE sessions and never rewrites an existing one
/// (doc/2026-09-07-权限模式.md). An absent or unrecognized value falls back to
/// `workspace-write`, matching the engine's own fallback.
pub fn read_default_permission_mode() -> Result<String, String> {
    let settings = read_json_file(&agent_dir()?.join("settings.json"), "{}")?;
    let mode = settings
        .get("defaultPermissionMode")
        .and_then(|v| v.as_str())
        .filter(|v| PERMISSION_MODES.contains(v))
        .unwrap_or("workspace-write");
    Ok(mode.to_string())
}

/// Set `defaultPermissionMode` in ~/.kalo/agent/settings.json.
///
/// Reads, patches the single field, and writes back: settings.json is shared
/// with the engine and the user, so replacing the whole document would discard
/// every other setting.
pub fn write_default_permission_mode(mode: &str) -> Result<(), String> {
    if !PERMISSION_MODES.contains(&mode) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    let path = agent_dir()?.join("settings.json");
    let mut settings = read_json_file(&path, "{}")?;
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "settings.json is not a JSON object".to_string())?;
    object.insert(
        "defaultPermissionMode".to_string(),
        serde_json::Value::String(mode.to_string()),
    );
    write_json_file(&path, &settings)
}
