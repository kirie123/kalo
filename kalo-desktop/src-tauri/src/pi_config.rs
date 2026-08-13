//! Read/write helpers for the pi engine's own configuration files:
//! `~/.pi/agent/models.json` (custom providers) and `~/.pi/agent/auth.json`
//! (API keys). The engine reads both at process start, so changes take
//! effect for newly spawned sessions.

use std::fs;
use std::path::PathBuf;

fn agent_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".pi").join("agent"))
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

/// Read ~/.pi/agent/models.json; returns `{"providers":{}}` when absent.
pub fn read_models_config() -> Result<serde_json::Value, String> {
    read_json_file(&agent_dir()?.join("models.json"), r#"{"providers":{}}"#)
}

/// Write ~/.pi/agent/models.json.
pub fn write_models_config(config: &serde_json::Value) -> Result<(), String> {
    write_json_file(&agent_dir()?.join("models.json"), config)
}

/// Read ~/.pi/agent/auth.json; returns `{}` when absent.
pub fn read_auth_config() -> Result<serde_json::Value, String> {
    read_json_file(&agent_dir()?.join("auth.json"), "{}")
}

/// Write ~/.pi/agent/auth.json.
pub fn write_auth_config(config: &serde_json::Value) -> Result<(), String> {
    write_json_file(&agent_dir()?.join("auth.json"), config)
}
