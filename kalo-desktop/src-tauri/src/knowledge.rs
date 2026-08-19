//! Personal knowledge base (P0-B, doc/kalo-personal-agent-roadmap.md §5;
//! upgraded by doc/2026-08-19-knowledge-notes-panel.md M1).
//!
//! Plain markdown under `~/.kalo/knowledge/`, no database and no index to
//! maintain by hand — retrieval is ripgrep (agent side) plus this module's
//! frontmatter listing and body search (desktop UI side).
//!
//! Layout (seeded by `ensure_knowledge_base` on app setup):
//!   cards/  inbox/  review/  _types/  .trash/  INDEX.md
//!
//! **Domains are directories, not a compile-time list.** Any top-level
//! directory is a domain; `_types/<domain>.md` may describe it (label, icon,
//! colour, order) but is purely presentational — the directory is the truth.
//!
//! Cards carry a YAML-ish frontmatter block (title/domain/tags/date/updated/
//! status/`_by`/`_reviewed`/source_session); parsing here is the same minimal
//! line-based approach as skills.rs — good enough for files our own templates
//! and the agent produce.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Directories created on first run. Pre-existing domains from earlier
/// versions (training-notes/ investing/ math/) are left alone: they keep
/// working because domains are discovered by scanning, not declared here.
const SEED_DIRS: [&str; 5] = ["cards", "inbox", "review", "_types", TRASH_DIR];

/// Backups of overwritten/deleted cards. Excluded from every scan.
const TRASH_DIR: &str = ".trash";

/// Markdown files that are never cards, wherever they appear.
const RESERVED_FILES: [&str; 3] = ["INDEX.md", "AGENTS.md", "README.md"];

/// Per-file cap on search hits, so one long note cannot fill the result list.
const MAX_HITS_PER_FILE: usize = 3;
const DEFAULT_SEARCH_LIMIT: usize = 50;
const SNIPPET_CHARS: usize = 120;
const HIT_SNIPPET_CHARS: usize = 160;

const INDEX_STUB: &str =
    "# 知识库索引\n\n<!-- 生成物：由 rebuild_knowledge_index 重写，请不要手工维护。 -->\n";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCardMeta {
    pub title: String,
    /// Top-level directory the card lives in ("" for root-level notes).
    pub domain: String,
    pub tags: Vec<String>,
    pub date: String,
    pub updated: String,
    pub status: String,
    /// `_by` frontmatter — who wrote it. Empty means the user.
    pub by: String,
    /// `_reviewed` frontmatter; None when the field is absent.
    pub reviewed: Option<bool>,
    /// Body length in characters (CJK counts per character, not per word).
    pub word_count: usize,
    /// First body line that is neither empty nor a heading.
    pub snippet: String,
    /// Path relative to the knowledge root (forward slashes), the stable
    /// handle used by all other commands.
    pub rel_path: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDomain {
    /// Directory name — the identity of the domain.
    pub key: String,
    /// `_label` from `_types/<key>.md`, or the key itself.
    pub label: String,
    pub icon: String,
    pub color: String,
    /// `_order`; unspecified sorts last.
    pub order: u32,
    pub count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchHit {
    pub rel_path: String,
    pub title: String,
    /// 1-based line number of the match.
    pub line: usize,
    pub snippet: String,
}

fn knowledge_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("knowledge"))
}

/// The single gate every traversal goes through: `.`-prefixed directories
/// (notably `.trash/`), `_`-prefixed ones (`_types/`) and `attachments/` are
/// not part of the note tree. Keeping this in one place is deliberate —
/// `.trash/` leaking into the list, the search or the link graph would be a
/// silent correctness bug, not a cosmetic one.
fn is_scannable_dir(name: &str) -> bool {
    !name.starts_with('.') && !name.starts_with('_') && name != "attachments"
}

/// First-run initialization: directory tree and INDEX.md stub. Existing
/// files are never overwritten — user edits survive app upgrades. The
/// `knowledge` skill that drives this store ships as a bundled skill
/// (`internal-skills/knowledge/`, installed by `internal_skills.rs`).
pub fn ensure_knowledge_base() {
    if let Ok(root) = knowledge_root() {
        for dir in SEED_DIRS {
            let _ = fs::create_dir_all(root.join(dir));
        }
        let index = root.join("INDEX.md");
        if !index.exists() {
            let _ = fs::write(&index, INDEX_STUB);
        }
    }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// List all cards recursively, sorted by date desc then title.
pub fn list_cards() -> Result<Vec<KnowledgeCardMeta>, String> {
    let root = knowledge_root()?;
    let mut out: Vec<KnowledgeCardMeta> = collect_card_paths(&root)
        .iter()
        .map(|path| build_meta(path, &root))
        .collect();
    out.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.title.cmp(&b.title)));
    Ok(out)
}

/// Every card file under the root, in a stable (sorted) order.
fn collect_card_paths(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_cards(root, &mut out);
    out.sort();
    out
}

fn walk_cards(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if is_scannable_dir(&name) {
                walk_cards(&path, out);
            }
        } else if name.ends_with(".md")
            && !name.starts_with('.')
            && !RESERVED_FILES.contains(&name.as_ref())
        {
            out.push(path);
        }
    }
}

/// Relative path from the knowledge root, with forward slashes.
fn rel_of(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn build_meta(path: &Path, root: &Path) -> KnowledgeCardMeta {
    let text = fs::read_to_string(path).unwrap_or_default();
    let (fm_lines, body) = split_card(&text);
    let fm = parse_frontmatter_lines(&fm_lines);
    let rel = rel_of(path, root);
    // The directory wins over `domain:` — see the doc's "目录是真相" rule.
    // Frontmatter is only a fallback for notes sitting at the root.
    let domain = match rel.split_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => fm.domain.clone().unwrap_or_default(),
    };
    KnowledgeCardMeta {
        title: card_title(&fm, path),
        domain,
        tags: fm.tags,
        date: fm.date.unwrap_or_default(),
        updated: fm.updated.unwrap_or_default(),
        status: fm.status.unwrap_or_default(),
        by: fm.by.unwrap_or_default(),
        reviewed: fm.reviewed,
        word_count: body.chars().count(),
        snippet: snippet_of(&body),
        rel_path: rel,
        path: path.to_string_lossy().into_owned(),
    }
}

/// `title:` frontmatter, else the first H1, else the file name.
fn card_title(fm: &CardFrontmatter, path: &Path) -> String {
    if let Some(t) = fm.title.as_ref().filter(|t| !t.is_empty()) {
        return t.clone();
    }
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// First body line that is neither blank nor a heading, truncated.
fn snippet_of(body: &str) -> String {
    let line = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("");
    truncate_chars(line, SNIPPET_CHARS)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/// Domains = scannable top-level directories, decorated with the optional
/// `_types/<key>.md` note. A missing `_types/` is normal: the label falls
/// back to the directory name and everything else keeps working.
pub fn list_domains() -> Result<Vec<KnowledgeDomain>, String> {
    let root = knowledge_root()?;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for card in list_cards()? {
        *counts.entry(card.domain).or_default() += 1;
    }

    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let key = entry.file_name().to_string_lossy().into_owned();
            if !is_scannable_dir(&key) {
                continue;
            }
            let count = counts.remove(&key).unwrap_or(0);
            out.push(domain_meta(&root, key, count));
        }
    }
    out.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key)));
    Ok(out)
}

fn domain_meta(root: &Path, key: String, count: usize) -> KnowledgeDomain {
    let type_note = root.join("_types").join(format!("{key}.md"));
    let text = fs::read_to_string(&type_note).unwrap_or_default();
    let (fm_lines, _) = split_card(&text);
    let get = |k: &str| frontmatter_value(&fm_lines, k).filter(|v| !v.is_empty());
    KnowledgeDomain {
        label: get("_label").unwrap_or_else(|| key.clone()),
        icon: get("_icon").unwrap_or_default(),
        color: get("_color").unwrap_or_default(),
        order: get("_order").and_then(|v| v.parse().ok()).unwrap_or(u32::MAX),
        key,
        count,
    }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Case-insensitive substring search over the whole file (frontmatter
/// included, so a title match is a hit too).
///
/// Deliberately not tokenized and with no minimum length: a two-character
/// Chinese query has to work, which rules out word-boundary matching. This is
/// the UI's only retrieval entry point — when P1-R's `recall` (FTS5 +
/// trigram) lands, this body is replaced and the callers stay put.
pub fn search_cards(query: &str, limit: Option<usize>) -> Result<Vec<KnowledgeSearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 500);
    let root = knowledge_root()?;
    let mut out = Vec::new();
    for path in collect_card_paths(&root) {
        if out.len() >= limit {
            break;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let hits = match_lines(&text, &needle, MAX_HITS_PER_FILE.min(limit - out.len()));
        if hits.is_empty() {
            continue;
        }
        let (fm_lines, _) = split_card(&text);
        let title = card_title(&parse_frontmatter_lines(&fm_lines), &path);
        let rel = rel_of(&path, &root);
        out.extend(hits.into_iter().map(|(line, snippet)| KnowledgeSearchHit {
            rel_path: rel.clone(),
            title: title.clone(),
            line,
            snippet,
        }));
    }
    Ok(out)
}

/// Matching lines as (1-based line number, truncated text), capped at `max`.
fn match_lines(text: &str, needle: &str, max: usize) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if out.len() >= max {
            break;
        }
        if line.to_lowercase().contains(needle) {
            out.push((i + 1, truncate_chars(line.trim(), HIT_SNIPPET_CHARS)));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Read / write / delete
// ---------------------------------------------------------------------------

/// Read one card verbatim.
pub fn read_card(rel_path: &str) -> Result<String, String> {
    let path = resolve_card_path(rel_path, false)?;
    fs::read_to_string(&path).map_err(|e| format!("failed to read card {rel_path}: {e}"))
}

/// Create or overwrite a card. With `rel_path` None a new file
/// `<domain>/<slug(title)>.md` is created (fails if it already exists);
/// otherwise the existing file is overwritten and its previous contents are
/// backed up under `.trash/`. `updated:` is stamped on the way through.
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
            let domain = domain.trim();
            // Any single, well-formed path segment is a valid domain — the
            // set of domains is whatever directories exist, not a constant.
            let domain = if domain.is_empty()
                || domain.contains(['/', '\\', ':'])
                || domain.starts_with('.')
                || domain.starts_with('_')
            {
                "cards"
            } else {
                domain
            };
            let mut slug = slugify(title);
            if slug.is_empty() {
                // Non-latin titles (e.g. pure Chinese) get a timestamp name.
                slug = format!("card-{}", unix_secs());
            }
            format!("{domain}/{slug}.md")
        }
    };
    let path = resolve_card_path(&rel, rel_path.is_none())?;
    if rel_path.is_none() && path.exists() {
        return Err(format!("card already exists: {rel}"));
    }
    let stamped = stamp_updated(content, &now_iso8601());

    // Back up the version we are about to lose. A failure here fails the
    // write: a best-effort backup is no backup at all on the one night the
    // agent overwrites something valuable.
    if rel_path.is_some() {
        if let Ok(previous) = fs::read_to_string(&path) {
            if previous != stamped {
                backup_to_trash(&rel, &previous)?;
            }
        }
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    }
    fs::write(&path, stamped).map_err(|e| format!("failed to write card {rel}: {e}"))?;
    Ok(rel)
}

/// Delete a card, backing it up under `.trash/` first.
pub fn delete_card(rel_path: &str) -> Result<(), String> {
    if RESERVED_FILES.contains(&rel_path) {
        return Err(format!("refusing to delete {rel_path}"));
    }
    let path = resolve_card_path(rel_path, false)?;
    let previous = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read card {rel_path} before deleting: {e}"))?;
    backup_to_trash(rel_path, &previous)?;
    fs::remove_file(&path).map_err(|e| format!("failed to delete card {rel_path}: {e}"))
}

/// Copy soon-to-be-lost contents to `.trash/<rel>.<unix_ts>.md`, keeping the
/// original directory structure. Not a version history: just the snapshot
/// that lets a bad overnight edit be undone. `git init` in the knowledge root
/// remains the answer for anyone wanting real history.
fn backup_to_trash(rel: &str, contents: &str) -> Result<(), String> {
    let trash = knowledge_root()?.join(TRASH_DIR);
    // `rel` already passed resolve_card_path (no `..`, no absolute, no
    // drive letters), so this join cannot escape; assert it anyway.
    let dest = trash.join(format!("{rel}.{}.md", unix_secs()));
    if !dest.starts_with(&trash) {
        return Err(format!("refusing to back up outside the trash: {rel:?}"));
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("failed to create backup directory {}: {e}", dir.display()))?;
    }
    fs::write(&dest, contents)
        .map_err(|e| format!("failed to back up {rel} to {}: {e}", dest.display()))
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

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`. Same shape and same
/// (Howard Hinnant civil-from-days) algorithm as memory.rs — folding the two
/// copies into a shared helper is queued with the other memory/knowledge
/// convergence work (M5 in the design doc).
fn now_iso8601() -> String {
    let secs = unix_secs();
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Set (or append) `updated:` in the frontmatter. Cards without frontmatter
/// are left untouched — we do not invent a block the author did not write.
///
/// Note: the file is rejoined with `\n`, so a CRLF card is normalized to LF.
/// Everything writing here (our templates, the agent) already uses LF.
fn stamp_updated(content: &str, now: &str) -> String {
    let (fm_lines, body) = split_card(content);
    if fm_lines.is_empty() {
        return content.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(fm_lines.len() + 1);
    let mut replaced = false;
    for line in &fm_lines {
        if !replaced && line.trim_start().starts_with("updated:") {
            out.push(format!("updated: {now}"));
            replaced = true;
        } else {
            out.push((*line).to_string());
        }
    }
    if !replaced {
        out.push(format!("updated: {now}"));
    }
    format!("---\n{}\n---\n{body}", out.join("\n"))
}

// ---------------------------------------------------------------------------
// Minimal frontmatter parsing (same style as skills.rs)
// ---------------------------------------------------------------------------

/// Frontmatter lines (between the `---` fences) and everything after the
/// closing fence, verbatim except for line-ending normalization. A file
/// without an opening fence is all body.
fn split_card(text: &str) -> (Vec<&str>, String) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return (Vec::new(), text.to_string());
    }
    match lines[1..].iter().position(|l| l.trim() == "---") {
        Some(idx) => (lines[1..=idx].to_vec(), lines[idx + 2..].join("\n")),
        // Unterminated fence: treat it all as frontmatter rather than
        // silently showing YAML as note content.
        None => (lines[1..].to_vec(), String::new()),
    }
}

#[derive(Default)]
struct CardFrontmatter {
    title: Option<String>,
    domain: Option<String>,
    tags: Vec<String>,
    date: Option<String>,
    updated: Option<String>,
    status: Option<String>,
    /// `_by` — underscore-prefixed system field, exposed as `by`.
    by: Option<String>,
    /// `_reviewed` — underscore-prefixed system field, exposed as `reviewed`.
    reviewed: Option<bool>,
}

fn parse_frontmatter_lines(lines: &[&str]) -> CardFrontmatter {
    let mut fm = CardFrontmatter::default();
    for line in lines {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key.trim() {
            "title" => fm.title = Some(value.to_string()),
            "domain" => fm.domain = Some(value.to_string()),
            "date" => fm.date = Some(value.to_string()),
            "updated" => fm.updated = Some(value.to_string()),
            "status" => fm.status = Some(value.to_string()),
            "tags" => fm.tags = parse_tags(value),
            "_by" => fm.by = Some(value.to_string()),
            "_reviewed" => fm.reviewed = Some(value.eq_ignore_ascii_case("true")),
            _ => {}
        }
    }
    fm
}

/// Raw value of one frontmatter key, for the `_types/` presentation fields
/// that do not deserve a struct of their own.
fn frontmatter_value(lines: &[&str], key: &str) -> Option<String> {
    for line in lines {
        let Some((k, value)) = line.trim().split_once(':') else {
            continue;
        };
        if k.trim() == key {
            return Some(
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    None
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

    /// Convenience for the parsing tests: parse a whole card's frontmatter.
    fn parse_card_frontmatter(text: &str) -> CardFrontmatter {
        parse_frontmatter_lines(&split_card(text).0)
    }

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
    fn parses_extended_frontmatter() {
        let text = "---\ntitle: T\nupdated: 2026-08-19T01:02:03Z\nstatus: seed\n_by: kalo\n_reviewed: false\n---\n\nbody\n";
        let fm = parse_card_frontmatter(text);
        assert_eq!(fm.updated.as_deref(), Some("2026-08-19T01:02:03Z"));
        assert_eq!(fm.status.as_deref(), Some("seed"));
        assert_eq!(fm.by.as_deref(), Some("kalo"));
        assert_eq!(fm.reviewed, Some(false));

        // Absent `_reviewed` must stay None, not default to false: "not
        // reviewed yet" and "no review workflow on this card" differ.
        let plain = parse_card_frontmatter("---\ntitle: T\n---\n");
        assert_eq!(plain.reviewed, None);
        assert_eq!(plain.by, None);
    }

    #[test]
    fn missing_frontmatter_yields_defaults() {
        let fm = parse_card_frontmatter("# no frontmatter\n");
        assert!(fm.title.is_none());
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn splits_frontmatter_from_body() {
        let (fm, body) = split_card("---\ntitle: T\n---\n\n## 背景\n\n内容\n");
        assert_eq!(fm, vec!["title: T"]);
        assert_eq!(body, "\n## 背景\n\n内容");

        // No fence at all: everything is body.
        let (fm, body) = split_card("plain\n");
        assert!(fm.is_empty());
        assert_eq!(body, "plain\n");

        // Unterminated fence: nothing is presented as note content.
        let (fm, body) = split_card("---\ntitle: T\n");
        assert_eq!(fm, vec!["title: T"]);
        assert_eq!(body, "");
    }

    #[test]
    fn excludes_trash_and_underscore_dirs() {
        // The one gate every traversal (list / search / graph) routes
        // through. `.trash/` leaking in would poison search results and,
        // later, the link graph.
        assert!(is_scannable_dir("cards"));
        assert!(is_scannable_dir("training-notes"));
        assert!(!is_scannable_dir(".trash"));
        assert!(!is_scannable_dir(".git"));
        assert!(!is_scannable_dir("_types"));
        assert!(!is_scannable_dir("attachments"));
    }

    #[test]
    fn snippet_skips_headings() {
        assert_eq!(snippet_of("\n## 背景\n\n实际内容在这里\n"), "实际内容在这里");
        assert_eq!(snippet_of("# 只有标题\n"), "");
        let long: String = "字".repeat(200);
        let snippet = snippet_of(&long);
        assert_eq!(snippet.chars().count(), SNIPPET_CHARS + 1); // + the ellipsis
    }

    #[test]
    fn search_finds_body_line() {
        let text = "---\ntitle: PrefixLM 更优\n---\n\n## 结论\n\nPrefixLM 在 100M 以下必败\n\n## 证据\n";
        // Two-character Chinese query: no tokenization, no minimum length.
        let hits = match_lines(text, "必败", 3);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, 7);
        assert_eq!(hits[0].1, "PrefixLM 在 100M 以下必败");

        // Case-insensitive, and a frontmatter title match counts.
        let hits = match_lines(text, "prefixlm", 3);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, 2);

        // Per-file cap is honoured.
        assert_eq!(match_lines(text, "prefixlm", 1).len(), 1);
        assert!(match_lines(text, "没有这个词", 3).is_empty());
    }

    #[test]
    fn stamps_updated() {
        let stamped = stamp_updated("---\ntitle: T\nupdated: old\n---\n\nbody\n", "NOW");
        assert_eq!(stamped, "---\ntitle: T\nupdated: NOW\n---\n\nbody");

        // Appended when absent.
        let stamped = stamp_updated("---\ntitle: T\n---\n\nbody\n", "NOW");
        assert_eq!(stamped, "---\ntitle: T\nupdated: NOW\n---\n\nbody");

        // No frontmatter: left exactly as-is rather than growing a block.
        assert_eq!(stamp_updated("just text\n", "NOW"), "just text\n");
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
