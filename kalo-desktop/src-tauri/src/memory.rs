//! Personal memory store (`~/.kalo/memory/*.md`).
//!
//! Mirrors skills.rs conventions: frontmatter parsing is intentionally
//! minimal, and all mutations are confined to the memory root. The
//! frontmatter format must stay in sync with the engine's built-in memory
//! extension (kalo-harness: packages/coding-agent/src/extensions/memory/).

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMeta {
    pub slug: String,
    pub title: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub updated: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub slug: String,
    pub title: String,
    pub tags: Vec<String>,
    pub created: String,
    pub updated: String,
    pub content: String,
}

/// `~/.kalo` (`USERPROFILE`, then `HOME`).
fn kalo_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo"))
}

/// `~/.kalo/memory`
fn memory_root() -> Result<PathBuf, String> {
    Ok(kalo_root()?.join("memory"))
}

/// Validate a caller-supplied slug and map it to a file inside the memory
/// root. Slugs are single path components: no separators, no `..`.
fn memory_path(slug: &str) -> Result<PathBuf, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("memory slug must not be empty".to_string());
    }
    if slug == ".." || slug.contains(['/', '\\', ':']) {
        return Err(format!("invalid memory slug: {slug:?}"));
    }
    Ok(memory_root()?.join(format!("{slug}.md")))
}

/// Derive a slug from a title: lowercase, non-alphanumeric runs become
/// `-`, CJK characters are kept. Falls back to a timestamp-based slug.
fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for c in title.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
            last_dash = false;
        } else if !slug.is_empty() && !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    let slug: String = slug.chars().take(60).collect();
    if slug.is_empty() {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("m-{secs:x}")
    } else {
        slug
    }
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`, computed without a date
/// crate (Howard Hinnant's civil-from-days algorithm).
fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Quote a frontmatter string value (always double-quoted, `\` and `"`
/// escaped), matching the extension's `quote()`.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Inverse of `quote()`: strip surrounding quotes and unescape.
fn unquote(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        t.to_string()
    }
}

/// Parsed view of one memory file.
struct ParsedMemory {
    title: String,
    tags: Vec<String>,
    created: String,
    updated: String,
    body: String,
}

/// Minimal frontmatter parse: `---` fences, top-level `title:` / `tags:` /
/// `created:` / `updated:` keys; everything after the closing fence is the
/// body. Returns None when the file has no frontmatter or no title.
fn parse_memory(text: &str) -> Option<ParsedMemory> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    let mut title = String::new();
    let mut tags = Vec::new();
    let mut created = String::new();
    let mut updated = String::new();
    let mut body_lines: Vec<&str> = Vec::new();
    let mut in_frontmatter = true;
    for line in lines {
        if in_frontmatter {
            let trimmed = line.trim();
            if trimmed == "---" {
                in_frontmatter = false;
                continue;
            }
            if let Some((key, value)) = trimmed.split_once(':') {
                let value = value.trim();
                match key.trim() {
                    "title" => title = unquote(value),
                    "created" => created = value.to_string(),
                    "updated" => updated = value.to_string(),
                    "tags" if value.starts_with('[') && value.ends_with(']') => {
                        tags = value[1..value.len() - 1]
                            .split(',')
                            .map(unquote)
                            .filter(|t| !t.is_empty())
                            .collect();
                    }
                    _ => {}
                }
            }
        } else {
            body_lines.push(line);
        }
    }
    if title.is_empty() {
        return None;
    }
    Some(ParsedMemory {
        title,
        tags,
        created,
        updated,
        body: body_lines.join("\n").trim().to_string(),
    })
}

fn serialize_memory(title: &str, tags: &[String], created: &str, updated: &str, body: &str) -> String {
    let tags = tags
        .iter()
        .map(|t| quote(t))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "---\ntitle: {}\ntags: [{tags}]\ncreated: {created}\nupdated: {updated}\n---\n\n{}\n",
        quote(title),
        body.trim()
    )
}

/// Summary = first non-empty body line (Markdown heading marks stripped),
/// truncated to 80 chars. Matches the extension's `summaryOf()`.
fn summary_of(body: &str) -> String {
    let line = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let stripped = line.trim_start_matches('#').trim_start();
    stripped.chars().take(80).collect()
}

/// List all memories (frontmatter + summary), newest first. A missing or
/// unreadable memory root yields an empty list; corrupt files are skipped.
pub fn list_memories() -> Result<Vec<MemoryMeta>, String> {
    let root = memory_root()?;
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let slug = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Some(m) = parse_memory(&text) else {
                continue;
            };
            out.push(MemoryMeta {
                slug,
                title: m.title,
                tags: m.tags,
                summary: summary_of(&m.body),
                updated: m.updated,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

/// Read one memory by slug.
pub fn read_memory(slug: &str) -> Result<MemoryEntry, String> {
    let path = memory_path(slug)?;
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read memory {}: {e}", path.display()))?;
    let m = parse_memory(&text)
        .ok_or_else(|| format!("memory file has no valid frontmatter: {}", path.display()))?;
    Ok(MemoryEntry {
        slug: slug.trim().to_string(),
        title: m.title,
        tags: m.tags,
        created: m.created,
        updated: m.updated,
        content: m.body,
    })
}

/// Create or overwrite a memory. With `slug` None a slug is derived from
/// the title; overwriting an existing memory preserves its `created`.
/// Returns the slug.
pub fn write_memory(
    slug: Option<&str>,
    title: &str,
    tags: &[String],
    content: &str,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("memory title must not be empty".to_string());
    }
    let slug = match slug {
        Some(s) => s.trim().to_string(),
        None => slugify(title),
    };
    let path = memory_path(&slug)?;
    let root = memory_root()?;
    fs::create_dir_all(&root).map_err(|e| format!("failed to create {}: {e}", root.display()))?;

    let now = now_iso8601();
    let created = fs::read_to_string(&path)
        .ok()
        .and_then(|text| parse_memory(&text))
        .filter(|m| !m.created.is_empty())
        .map(|m| m.created)
        .unwrap_or_else(|| now.clone());

    let tags: Vec<String> = tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    let text = serialize_memory(title, &tags, &created, &now, content);
    fs::write(&path, text).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    Ok(slug)
}

/// Delete a memory by slug. The canonicalized path must live directly
/// under the memory root.
pub fn delete_memory(slug: &str) -> Result<(), String> {
    let path = memory_path(slug)?;
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("failed to resolve memory path {}: {e}", path.display()))?;
    let root_canonical = fs::canonicalize(memory_root()?).map_err(|e| format!("failed to resolve memory root: {e}"))?;
    if canonical.parent() != Some(root_canonical.as_path()) {
        return Err(format!(
            "refusing to delete {}: not inside the kalo memory directory",
            canonical.display()
        ));
    }
    fs::remove_file(&canonical).map_err(|e| format!("failed to delete {}: {e}", canonical.display()))
}
