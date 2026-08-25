//! First-run onboarding marker (`~/.kalo/onboarding.json`).
//!
//! A file rather than localStorage: clearing the webview's storage (or moving
//! to another one) must not re-show the tour, and deleting the file by hand is
//! how both users and tests ask to see it again.
//!
//! The document is deliberately open-ended — the frontend owns its shape and
//! this module only guards the two things it needs to be true (a JSON object,
//! written atomically).

use std::fs;
use std::path::PathBuf;

/// `~/.kalo` (`USERPROFILE`, then `HOME`).
fn kalo_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo"))
}

/// Read the marker. A missing or unparseable file yields `{}` — "never
/// completed" — because a corrupt marker should show the tour, not fail the
/// app's first paint.
#[tauri::command]
pub fn read_onboarding_state() -> Result<serde_json::Value, String> {
    let path = kalo_root()?.join("onboarding.json");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))),
        Err(_) => Ok(serde_json::json!({})),
    }
}

/// Overwrite the marker (tmp + rename, same as `mcp.rs`).
#[tauri::command]
pub fn write_onboarding_state(state: serde_json::Value) -> Result<(), String> {
    if !state.is_object() {
        return Err("onboarding.json must be a JSON object".to_string());
    }
    let dir = kalo_root()?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    let path = dir.join("onboarding.json");
    let text = serde_json::to_string_pretty(&state).map_err(|e| format!("failed to serialize: {e}"))?;
    let tmp = dir.join("onboarding.json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to replace {}: {e}", path.display()))
}
