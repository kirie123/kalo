//! Personal knowledge base (P0-B, doc/kalo-personal-agent-roadmap.md §5).
//!
//! Plain markdown under `~/.kalo/knowledge/`, no database and no index to
//! maintain — retrieval is ripgrep (agent side) plus this module's
//! frontmatter listing (desktop UI side).
//!
//! Layout (created by `ensure_knowledge_base` on app setup):
//!   cards/  training-notes/  investing/  math/  INDEX.md
//!
//! Cards carry a YAML-ish frontmatter block (title/domain/tags/date/
//! source_session); parsing here is the same minimal line-based approach as
//! skills.rs — good enough for files our own skill template produces.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The four domains from the roadmap; also the subdirectories created on
/// first run. Cards may live elsewhere in the tree, but new cards created
/// from the UI are placed into one of these.
const DOMAINS: [&str; 4] = ["cards", "training-notes", "investing", "math"];

const INDEX_STUB: &str = "# 知识库索引\n\n<!-- 由 knowledge skill 在存卡时维护：- [标题](路径) — tags（日期） -->\n\n## cards\n\n## training-notes\n\n## investing\n\n## math\n";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCardMeta {
    pub title: String,
    pub domain: String,
    pub tags: Vec<String>,
    pub date: String,
    /// Path relative to the knowledge root (forward slashes), the stable
    /// handle used by all other commands.
    pub rel_path: String,
    pub path: String,
}

fn knowledge_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("knowledge"))
}

/// First-run initialization: knowledge directory tree and INDEX.md stub.
/// Existing files are never overwritten — user edits survive app upgrades.
/// The `knowledge` skill that drives this store ships as a bundled skill
/// (`internal-skills/knowledge/`, installed by `internal_skills.rs`).
pub fn ensure_knowledge_base() {
    if let Ok(root) = knowledge_root() {
        for domain in DOMAINS {
            let _ = fs::create_dir_all(root.join(domain));
        }
        let index = root.join("INDEX.md");
        if !index.exists() {
            let _ = fs::write(&index, INDEX_STUB);
        }
    }
}

/// List all cards recursively (INDEX.md excluded), sorted by date desc
/// then title.
pub fn list_cards() -> Result<Vec<KnowledgeCardMeta>, String> {
    let root = knowledge_root()?;
    let mut out = Vec::new();
    collect_cards(&root, &root, &mut out);
    out.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.title.cmp(&b.title)));
    Ok(out)
}

fn collect_cards(dir: &Path, root: &Path, out: &mut Vec<KnowledgeCardMeta>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_cards(&path, root, out);
        } else if name.ends_with(".md") && name != "INDEX.md" {
            out.push(build_meta(&path, root));
        }
    }
}

fn build_meta(path: &Path, root: &Path) -> KnowledgeCardMeta {
    let fm = fs::read_to_string(path)
        .map(|text| parse_card_frontmatter(&text))
        .unwrap_or_default();
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let domain = fm
        .domain
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| rel.split('/').next().unwrap_or_default().to_string());
    KnowledgeCardMeta {
        title: fm.title.filter(|t| !t.is_empty()).unwrap_or(fallback_title),
        domain,
        tags: fm.tags,
        date: fm.date.unwrap_or_default(),
        rel_path: rel,
        path: path.to_string_lossy().into_owned(),
    }
}

/// Read one card verbatim.
pub fn read_card(rel_path: &str) -> Result<String, String> {
    let path = resolve_card_path(rel_path, false)?;
    fs::read_to_string(&path).map_err(|e| format!("failed to read card {rel_path}: {e}"))
}

/// Create or overwrite a card. With `rel_path` None a new file
/// `<domain>/<slug(title)>.md` is created (fails if it already exists).
/// Returns the card's rel path.
pub fn write_card(
    rel_path: Option<&str>,
    domain: &str,
    title: &str,
    content: &str,
) -> Result<String, String> {
    let rel = match rel_path {
        Some(rel) => rel.to_string(),
        None => {
            let domain = if DOMAINS.contains(&domain) { domain } else { "cards" };
            let mut slug = slugify(title);
            if slug.is_empty() {
                // Non-latin titles (e.g. pure Chinese) get a timestamp name.
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                slug = format!("card-{secs}");
            }
            format!("{domain}/{slug}.md")
        }
    };
    let path = resolve_card_path(&rel, rel_path.is_none())?;
    if rel_path.is_none() && path.exists() {
        return Err(format!("card already exists: {rel}"));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    }
    fs::write(&path, content).map_err(|e| format!("failed to write card {rel}: {e}"))?;
    Ok(rel)
}

/// Delete a card (INDEX.md is refused).
pub fn delete_card(rel_path: &str) -> Result<(), String> {
    if rel_path == "INDEX.md" {
        return Err("refusing to delete INDEX.md".to_string());
    }
    let path = resolve_card_path(rel_path, false)?;
    fs::remove_file(&path).map_err(|e| format!("failed to delete card {rel_path}: {e}"))
}

/// Resolve a rel path against the knowledge root, rejecting traversal.
/// Existing files are canonicalized and must stay under the root.
fn resolve_card_path(rel_path: &str, allow_missing: bool) -> Result<PathBuf, String> {
    let root = knowledge_root()?;
    let rel = rel_path.replace('\\', "/");
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.split('/').any(|c| c.is_empty() || c == "." || c == ".." || c.contains(':'))
    {
        return Err(format!("invalid card path: {rel_path:?}"));
    }
    if !rel.ends_with(".md") {
        return Err(format!("not a markdown card: {rel_path:?}"));
    }
    let path = root.join(&rel);
    if allow_missing && !path.exists() {
        return Ok(path);
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("failed to resolve card path {rel_path:?}: {e}"))?;
    let canonical_root = fs::canonicalize(&root).unwrap_or(root);
    if !canonical.starts_with(&canonical_root) {
        return Err(format!("card path escapes the knowledge root: {rel_path:?}"));
    }
    Ok(canonical)
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for c in title.trim().chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug.chars().take(60).collect()
}

// ---------------------------------------------------------------------------
// Minimal frontmatter parsing (same style as skills.rs)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct CardFrontmatter {
    title: Option<String>,
    domain: Option<String>,
    tags: Vec<String>,
    date: Option<String>,
}

fn parse_card_frontmatter(text: &str) -> CardFrontmatter {
    let mut fm = CardFrontmatter::default();
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return fm;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key.trim() {
            "title" => fm.title = Some(value.to_string()),
            "domain" => fm.domain = Some(value.to_string()),
            "date" => fm.date = Some(value.to_string()),
            "tags" => fm.tags = parse_tags(value),
            _ => {}
        }
    }
    fm
}

/// `tags: [a, b]` inline list, or a bare comma-separated `tags: a, b`.
fn parse_tags(value: &str) -> Vec<String> {
    let inner = value.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|t| t.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_card_frontmatter() {
        let text = "---\ntitle: PrefixLM 更优\ndomain: training-notes\ntags: [hrm, prefixlm]\ndate: 2026-08-15\nsource_session: a3f9c2\n---\n## 背景\n";
        let fm = parse_card_frontmatter(text);
        assert_eq!(fm.title.as_deref(), Some("PrefixLM 更优"));
        assert_eq!(fm.domain.as_deref(), Some("training-notes"));
        assert_eq!(fm.tags, vec!["hrm", "prefixlm"]);
        assert_eq!(fm.date.as_deref(), Some("2026-08-15"));
    }

    #[test]
    fn missing_frontmatter_yields_defaults() {
        let fm = parse_card_frontmatter("# no frontmatter\n");
        assert!(fm.title.is_none());
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("PrefixLM 在 HRM 上更优！"), "prefixlm-hrm");
        assert_eq!(slugify("  --already--slug--  "), "already-slug");
        assert_eq!(slugify("纯中文标题"), ""); // caller falls back to a timestamp name
    }

    #[test]
    fn rejects_traversal() {
        assert!(resolve_card_path("../secret.md", false).is_err());
        assert!(resolve_card_path("a/../../b.md", false).is_err());
        assert!(resolve_card_path("/abs.md", false).is_err());
        assert!(resolve_card_path("cards/ok.txt", false).is_err());
    }
}
