//! Fresh chat workspaces (`~/.kalo/workspaces/`).
//!
//! 「新对话」must not inherit the previous session's working directory: an
//! unrelated question would otherwise run inside the last project (reading its
//! AGENTS.md, writing files into it), and a chat started right after an expert
//! session would keep the expert's directory without its identity.
//!
//! So each fresh chat gets its own empty directory: `chat-<n>`, numbered from
//! the highest existing suffix. Sequence numbers rather than timestamps —
//! local-vs-UTC drift would name a folder after the wrong day, and ordering
//! stays deterministic. An existing `chat-<n>` that is still empty (the user
//! clicked 新对话 but never used it) is handed back instead of piling up empty
//! shells.
//!
//! Design: doc/2026-09-07-新对话工作目录.md.

use std::fs;
use std::path::{Path, PathBuf};

/// `~/.kalo/workspaces`
fn workspaces_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("workspaces"))
}

/// `chat-<n>` suffix of a directory name, or `None` for anything else.
fn chat_index(name: &str) -> Option<u32> {
    name.strip_prefix("chat-")?.parse::<u32>().ok()
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
}

/// Pick (creating if needed) the directory a fresh chat should run in.
/// Reuses the highest-numbered `chat-<n>` while it is still empty.
fn pick(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| format!("创建 {} 失败：{e}", root.display()))?;

    let mut highest: Option<u32> = None;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(n) = chat_index(&entry.file_name().to_string_lossy()) else {
                continue;
            };
            if highest.is_none_or(|h| n > h) {
                highest = Some(n);
            }
        }
    }

    if let Some(n) = highest {
        let candidate = root.join(format!("chat-{n}"));
        if is_empty_dir(&candidate) {
            return Ok(candidate);
        }
    }

    let next = highest.map(|n| n + 1).unwrap_or(1);
    let dir = root.join(format!("chat-{next}"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    Ok(dir)
}

/// Absolute path of a working directory for a fresh chat.
#[tauri::command(async)]
pub fn create_workspace() -> Result<String, String> {
    Ok(pick(&workspaces_root()?)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kalo-ws-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn first_call_creates_chat_1() {
        let root = tmp_root("first");
        let dir = pick(&root).unwrap();
        assert!(dir.ends_with("chat-1"));
        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_dir_is_reused_used_one_advances() {
        let root = tmp_root("reuse");
        let first = pick(&root).unwrap();
        // Untouched: the same directory comes back.
        assert_eq!(pick(&root).unwrap(), first);
        // Used: the next call moves on.
        fs::write(first.join("notes.md"), "x").unwrap();
        let second = pick(&root).unwrap();
        assert!(second.ends_with("chat-2"));
        assert_ne!(second, first);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn numbering_continues_past_gaps_and_ignores_foreign_dirs() {
        let root = tmp_root("gaps");
        fs::create_dir_all(root.join("chat-7")).unwrap();
        fs::write(root.join("chat-7").join("a.txt"), "x").unwrap();
        fs::create_dir_all(root.join("my-project")).unwrap();
        assert!(pick(&root).unwrap().ends_with("chat-8"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chat_index_parses_only_plain_suffixes() {
        assert_eq!(chat_index("chat-3"), Some(3));
        assert_eq!(chat_index("chat-03"), Some(3));
        assert_eq!(chat_index("chat-"), None);
        assert_eq!(chat_index("chat-3x"), None);
        assert_eq!(chat_index("project"), None);
    }
}
