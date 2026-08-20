//! Historical session scanning.
//!
//! pi stores past sessions under `%USERPROFILE%/.kalo/agent/sessions/<encoded-cwd>/`
//! as `*.jsonl` files. The first line of each file is a header:
//! `{"type":"session","id":"...","timestamp":"...","cwd":"..."}`.
//! Later lines may carry a display name (`type: "session_info"` with a
//! `name` field) and user messages
//! (`{"type":"message","message":{"role":"user","content":...}}`), which we
//! use to build a title.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
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

/// Delete one session file. The canonicalized path must be a `.jsonl` file
/// inside the sessions root; anything else is refused.
pub fn delete_session(path: &str) -> Result<(), String> {
    let root = sessions_root().ok_or("cannot resolve sessions root")?;
    let canonical_root = fs::canonicalize(&root).unwrap_or(root);
    let canonical = fs::canonicalize(path)
        .map_err(|e| format!("failed to resolve session path {path}: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(format!(
            "refusing to delete {}: not inside the sessions directory",
            canonical.display()
        ));
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(format!("not a session file: {}", canonical.display()));
    }
    fs::remove_file(&canonical)
        .map_err(|e| format!("failed to delete {}: {e}", canonical.display()))
}

/// Append a `session_info` entry naming a historical session — the same
/// entry the engine's `set_session_name` would write, without needing a
/// live engine. The name is trimmed and must be non-empty; the path must
/// be a `.jsonl` inside the sessions root (same guard as delete_session).
pub fn rename_session(path: &str, name: &str) -> Result<(), String> {
    let root = sessions_root().ok_or("cannot resolve sessions root")?;
    rename_session_in(&root, path, name)
}

/// Core of rename_session, root injected for tests.
fn rename_session_in(root: &Path, path: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let canonical = fs::canonicalize(path)
        .map_err(|e| format!("failed to resolve session path {path}: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(format!(
            "refusing to rename {}: not inside the sessions directory",
            canonical.display()
        ));
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(format!("not a session file: {}", canonical.display()));
    }

    // The last entry's id is the rename's parent (the current leaf — the
    // engine links a session_info entry to its leaf and then advances the
    // leaf to the new entry). Collect every id along the way so the new
    // entry's id cannot collide.
    let text = fs::read_to_string(&canonical)
        .map_err(|e| format!("failed to read {}: {e}", canonical.display()))?;
    let mut ids = HashSet::new();
    let mut parent_id: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue; // tolerate corrupt lines, like the pager does
        };
        if let Some(id) = value.get("id").and_then(|i| i.as_str()) {
            ids.insert(id.to_string());
            parent_id = Some(id.to_string());
        }
    }

    let mut entry = serde_json::json!({
        "type": "session_info",
        "id": unique_entry_id(&ids),
        "timestamp": iso_now(),
        "name": name,
    });
    if let Some(pid) = parent_id {
        entry["parentId"] = serde_json::Value::String(pid);
    }
    let line = serde_json::to_string(&entry)
        .map_err(|e| format!("failed to serialize session_info entry: {e}"))?;

    let mut out = fs::OpenOptions::new()
        .append(true)
        .open(&canonical)
        .map_err(|e| format!("failed to open {} for append: {e}", canonical.display()))?;
    // Defensive: the engine always ends its writes with a newline, but a
    // torn write would otherwise glue this entry to the previous line.
    if !text.ends_with('\n') {
        out.write_all(b"\n")
            .map_err(|e| format!("failed to append to {}: {e}", canonical.display()))?;
    }
    writeln!(out, "{line}")
        .map_err(|e| format!("failed to append to {}: {e}", canonical.display()))
}

/// 8-hex-char entry id in the engine's style (`randomUUID().slice(0, 8)`),
/// mixed with wall-clock time and the process id so renames stay unique
/// across processes, and guaranteed distinct from every id in the file.
fn unique_entry_id(existing: &HashSet<String>) -> String {
    let mut n = existing.len() as u64;
    loop {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0) as u64;
        let id = format!(
            "{:08x}",
            (nanos ^ (std::process::id() as u64) ^ n.rotate_left(13)) & 0xFFFF_FFFF
        );
        if !existing.contains(&id) {
            return id;
        }
        n = n.wrapping_add(1);
    }
}

/// ISO-8601 UTC timestamp in the engine's `new Date().toISOString()` shape.
/// Sub-second precision is omitted — nothing reads it.
fn iso_now() -> String {
    let total = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let (y, m, d) = civil_from_days(total.div_euclid(86_400));
    let secs = total.rem_euclid(86_400);
    let (h, mi, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Howard Hinnant's civil_from_days: days since 1970-01-01 → (y, m, d).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
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

    // Walk the whole file for the latest `session_info` display name — a
    // rename can happen anywhere in a long session, and the engine's
    // getSessionName() also takes the last entry — plus the first user
    // message (within the first 100 lines) as the fallback title. Cheap
    // substring gates skip JSON parsing for the vast majority of lines.
    let mut name: Option<String> = None; // raw latest session_info name (may be empty)
    let mut first_user_text: Option<String> = None;
    for (i, line) in reader.lines().enumerate() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if i < 100 && first_user_text.is_none() && trimmed.contains("\"role\":\"user\"") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if value.get("type").and_then(|t| t.as_str()) == Some("message") {
                    if let Some(message) = value.get("message") {
                        if message.get("role").and_then(|r| r.as_str()) == Some("user") {
                            first_user_text = extract_text(message.get("content"));
                        }
                    }
                }
            }
        }
        if trimmed.contains("session_info") || trimmed.contains("session_name") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let ty = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ty == "session_info" || ty == "session_name" {
                    // Latest entry wins; an empty name clears the title
                    // (both match the engine's getSessionName semantics).
                    name = value.get("name").and_then(|n| n.as_str()).map(|n| n.to_string());
                }
            }
        }
    }

    let title = name
        .filter(|n| !n.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn session_header() -> String {
        r#"{"type":"session","id":"sess-1","timestamp":"2026-08-20T00:00:00Z","cwd":"C:/work"}"#
            .to_string()
    }

    fn user_msg(id: &str, parent: &str, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":"2026-08-20T00:00:00Z","message":{{"role":"user","content":"{text}"}}}}"#
        )
    }

    fn info_entry(id: &str, parent: &str, name: &str) -> String {
        format!(
            r#"{{"type":"session_info","id":"{id}","parentId":"{parent}","timestamp":"2026-08-20T00:00:00Z","name":"{name}"}}"#
        )
    }

    fn write_session(path: &Path, entries: &[String]) {
        let mut s = session_header();
        s.push('\n');
        for e in entries {
            s.push_str(e);
            s.push('\n');
        }
        fs::write(path, s).unwrap();
    }

    fn parse_title(path: &Path) -> String {
        parse_session_file(path).unwrap().1.title
    }

    fn temp_session(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("kalo-sessions-test-{name}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        (dir, path)
    }

    #[test]
    fn title_falls_back_to_first_user_message() {
        let (dir, path) = temp_session("fallback");
        write_session(&path, &[user_msg("m1", "", "第一句用户消息")]);
        assert_eq!(parse_title(&path), "第一句用户消息");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_wins_over_first_user_message() {
        let (dir, path) = temp_session("rename-wins");
        write_session(
            &path,
            &[
                user_msg("m1", "", "旧标题来源"),
                info_entry("i1", "m1", "新标题"),
            ],
        );
        assert_eq!(parse_title(&path), "新标题");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn latest_rename_wins() {
        let (dir, path) = temp_session("latest-wins");
        write_session(
            &path,
            &[
                user_msg("m1", "", "提示词"),
                info_entry("i1", "m1", "第一次改名"),
                user_msg("m2", "i1", "继续聊"),
                info_entry("i2", "m2", "第二次改名"),
            ],
        );
        assert_eq!(parse_title(&path), "第二次改名");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_beyond_first_100_lines_is_found() {
        let (dir, path) = temp_session("deep-rename");
        // 150 messages push the rename entry past the old 100-line scan window.
        let mut entries: Vec<String> = (0..150)
            .map(|i| {
                let parent = if i == 0 { String::new() } else { format!("m{}", i - 1) };
                user_msg(&format!("m{i}"), &parent, "消息")
            })
            .collect();
        entries.push(info_entry("i1", "m149", "深水区标题"));
        write_session(&path, &entries);
        assert_eq!(parse_title(&path), "深水区标题");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_name_falls_back_to_user_message() {
        let (dir, path) = temp_session("empty-name");
        write_session(
            &path,
            &[
                user_msg("m1", "", "首条消息"),
                info_entry("i1", "m1", ""),
            ],
        );
        assert_eq!(parse_title(&path), "首条消息");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_appends_engine_compatible_entry() {
        let (dir, path) = temp_session("append");
        write_session(
            &path,
            &[
                user_msg("m1", "", "提示词"),
                user_msg("m2", "m1", "追问"),
            ],
        );

        rename_session_in(&dir, path.to_str().unwrap(), "  手工标题  ").unwrap();

        // Title read back through the scanner.
        assert_eq!(parse_title(&path), "手工标题");

        // The appended line matches the engine's SessionInfoEntry shape and
        // links to the previous leaf (last message id) with a fresh id.
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
        assert_eq!(last["type"], "session_info");
        assert_eq!(last["parentId"], "m2");
        assert_eq!(last["name"], "手工标题");
        assert!(last["id"].as_str().unwrap().len() == 8);
        // No id duplicates across the file.
        let mut seen = std::collections::HashSet::new();
        for line in lines {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let id = v["id"].as_str().unwrap();
            assert!(seen.insert(id.to_string()), "duplicate id {id}");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_rejects_empty_name_and_foreign_path() {
        let (dir, path) = temp_session("guards");
        write_session(&path, &[user_msg("m1", "", "提示词")]);

        let err = rename_session_in(&dir, path.to_str().unwrap(), "   ").unwrap_err();
        assert!(err.contains("不能为空"));

        // Outside the sessions root is refused.
        let outside = dir.join("..").join("foreign.jsonl");
        fs::write(&outside, "{}").unwrap();
        let err = rename_session_in(&dir, outside.to_str().unwrap(), "标题").unwrap_err();
        assert!(err.contains("not inside"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn civil_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
    }

    #[test]
    fn unique_entry_id_avoids_existing_ids() {
        let mut existing = HashSet::new();
        for i in 0..10 {
            existing.insert(format!("{i:08x}"));
        }
        let id = unique_entry_id(&existing);
        assert_eq!(id.len(), 8);
        assert!(!existing.contains(&id));
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
