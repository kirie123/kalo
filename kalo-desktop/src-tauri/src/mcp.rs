//! MCP server configuration (`~/.kalo/agent/mcp.json`) and engine status
//! mirror (`~/.kalo/agent/mcp-status.json`).
//!
//! The engine's built-in MCP extension (kalo-harness:
//! packages/coding-agent/src/extensions/mcp/) reads mcp.json at session
//! start and writes mcp-status.json after the handshake; the desktop only
//! needs read/write passthrough plus the status snapshot for display.

use std::fs;
use std::path::PathBuf;

/// `~/.kalo` (`USERPROFILE`, then `HOME`).
fn kalo_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo"))
}

fn agent_dir() -> Result<PathBuf, String> {
    Ok(kalo_root()?.join("agent"))
}

/// Read mcp.json as raw JSON. A missing file yields `{ "servers": {} }`
/// so the settings page always renders a valid document.
#[tauri::command]
pub fn read_mcp_config() -> Result<serde_json::Value, String> {
    let path = agent_dir()?.join("mcp.json");
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("mcp.json is not valid JSON: {e}")),
        Err(_) => Ok(serde_json::json!({ "servers": {} })),
    }
}

/// Atomically overwrite mcp.json. The value must be an object with a
/// `servers` map; anything else is rejected (the engine depends on it).
#[tauri::command]
pub fn write_mcp_config(config: serde_json::Value) -> Result<(), String> {
    let servers = config
        .get("servers")
        .and_then(|s| s.as_object())
        .ok_or("mcp.json must contain a \"servers\" object")?;
    for (name, def) in servers {
        if name.trim().is_empty() {
            return Err("server name must not be empty".to_string());
        }
        if def.get("command").and_then(|c| c.as_str()).map_or(true, |c| c.trim().is_empty()) {
            return Err(format!("server \"{name}\" needs a non-empty command"));
        }
    }

    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    let path = dir.join("mcp.json");
    let text = serde_json::to_string_pretty(&config).map_err(|e| format!("failed to serialize: {e}"))?;
    let tmp = dir.join("mcp.json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to replace {}: {e}", path.display()))?;
    Ok(())
}

/// Read mcp-status.json (engine-written handshake results). Missing file
/// means no session has run since the config changed.
#[tauri::command]
pub fn read_mcp_status() -> Result<serde_json::Value, String> {
    let path = agent_dir()?.join("mcp-status.json");
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("mcp-status.json is not valid JSON: {e}")),
        Err(_) => Ok(serde_json::json!({ "servers": {}, "updatedAt": null })),
    }
}
