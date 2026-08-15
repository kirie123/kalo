//! Historical session scanning.
//!
//! pi stores past sessions under `%USERPROFILE%/.kalo/agent/sessions/<encoded-cwd>/`
//! as `*.jsonl` files. The first line of each file is a header:
//! `{"type":"session","id":"...","timestamp":"...","cwd":"..."}`.
//! Later lines may carry a display name (`type: "session_info"` with a
//! `name` field) and user messages
//! (`{"type":"message","message":{"role":"user","content":...}}`), which we
//! use to build a title.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub path: String,
    pub id: String,
    pub timestamp: String,
    pub title: String,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectGroup {
    pub cwd: String,
    pub sessions: Vec<SessionMeta>,
}

/// List all historical sessions grouped by project cwd.
/// A missing sessions directory yields an empty list, not an error.
pub fn list_sessions() -> Result<Vec<ProjectGroup>, String> {
    let Some(root) = sessions_root() else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&root).map_err(|e| format!("failed to read {}: {e}", root.display()))?;

    let mut parsed: Vec<(String, SessionMeta)> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&dir) {
            Ok(files) => files,
            Err(e) => {
                eprintln!("[kalo] skipping unreadable dir {}: {e}", dir.display());
                continue;
            }
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            match parse_session_file(&path) {
                Some(item) => parsed.push(item),
                None => eprintln!("[kalo] skipping unparseable session file {}", path.display()),
            }
        }
    }

    let mut groups: HashMap<String, Vec<SessionMeta>> = HashMap::new();
    for (cwd, meta) in parsed {
        groups.entry(cwd).or_default().push(meta);
    }

    let mut out: Vec<ProjectGroup> = groups
        .into_iter()
        .map(|(cwd, mut sessions)| {
            sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
            ProjectGroup { cwd, sessions }
        })
        .collect();
    // Newest project first, by its most recently modified session.
    out.sort_by(|a, b| {
        let am = a.sessions.first().map(|s| s.modified_ms).unwrap_or(0);
        let bm = b.sessions.first().map(|s| s.modified_ms).unwrap_or(0);
        bm.cmp(&am)
    });
    Ok(out)
}

/// `%USERPROFILE%/.kalo/agent/sessions` (`HOME` as a fallback).
fn sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(
        PathBuf::from(home)
            .join(".kalo")
            .join("agent")
            .join("sessions"),
    )
}

/// Parse one session file into `(cwd, SessionMeta)`, or `None` if it does
/// not look like a pi session file.
fn parse_session_file(path: &Path) -> Option<(String, SessionMeta)> {
    let file = fs::File::open(path).ok()?;
    let modified_ms = file
        .metadata()
        .ok()?
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut reader = BufReader::new(file);

    // First line must be the session header.
    let mut header_line = String::new();
    reader.read_line(&mut header_line).ok()?;
    let header: serde_json::Value = serde_json::from_str(header_line.trim()).ok()?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    let id = header.get("id")?.as_str()?.to_string();
    let timestamp = header
        .get("timestamp")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let cwd = header
        .get("cwd")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();

    // Scan the first 100 lines after the header for a display name and the
    // first user message.
    let mut name: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    for line in reader.lines().take(100) {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let ty = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if name.is_none() && (ty == "session_info" || ty == "session_name") {
            if let Some(n) = value.get("name").and_then(|n| n.as_str()) {
                name = Some(n.to_string());
            }
        }

        if first_user_text.is_none() && ty == "message" {
            if let Some(message) = value.get("message") {
                if message.get("role").and_then(|r| r.as_str()) == Some("user") {
                    first_user_text = extract_text(message.get("content"));
                }
            }
        }

        if name.is_some() && first_user_text.is_some() {
            break;
        }
    }

    let title = name
        .or(first_user_text)
        .map(|t| truncate(&collapse_whitespace(&t), 80))
        .unwrap_or_else(|| "Untitled session".to_string());

    Some((
        cwd,
        SessionMeta {
            path: path.to_string_lossy().into_owned(),
            id,
            timestamp,
            title,
            modified_ms,
        },
    ))
}

/// Message content is either a plain string or an array of parts like
/// `{"type":"text","text":"..."}`.
fn extract_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}
