//! Paged reading of a pi session file for the history viewer.
//!
//! A session file is JSONL: after the `{"type":"session", ...}` header each
//! line is one entry. The engine appends *every* entry as a child of the
//! current leaf (`parentId` = previous leaf id, then the leaf advances), so
//! the file is a single parent chain where entries of many kinds live
//! (`message`, `compaction`, `session_info`, `model_change`, ...).
//!
//! Message entries look like `{"type":"message","id":"...","parentId":"...",
//! "message":{...}}`; compaction entries like `{"type":"compaction",
//! "id":"...","parentId":"...","summary":"...","tokensBefore":N}`. The pager
//! walks the *whole* chain (any entry with an id is a node, so a compaction
//! or a rename in the middle never truncates the history), then pages over
//! the renderable entries only — message payloads verbatim, compaction nodes
//! synthesized into `{"role":"compactionSummary","summary":...}` messages so
//! the desktop can render a persistent "auto-compaction" bubble (see
//! doc/2026-09-09-自动压缩气泡常驻与摘要展开.md).

use std::collections::{HashMap, HashSet};
use std::fs;

use serde::Serialize;
use serde_json::value::RawValue;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub messages: Vec<serde_json::Value>,
    pub start: usize,
    pub total: usize,
    pub has_more: bool,
}

/// Cheap head parse of one session line: kind + chain link (`id`/`parentId`)
/// + a borrowed payload slice for message lines. Unknown fields are ignored,
/// so this handles every entry kind without building a full DOM.
#[derive(serde::Deserialize)]
struct LineHead<'a> {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<&'a str>,
    #[serde(rename = "parentId")]
    parent_id: Option<&'a str>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
}

#[derive(Clone, Copy, PartialEq)]
enum NodeKind {
    /// A transcript message — payload passed through verbatim.
    Message,
    /// A compaction entry — synthesized into a compactionSummary message.
    Compaction,
    /// Any other chain node: kept for parent-link continuity only.
    Connector,
}

/// One node of the session chain. The whole trimmed line is kept raw so a
/// windowed compaction entry can re-parse its summary lazily.
struct Node<'a> {
    kind: NodeKind,
    parent_id: Option<&'a str>,
    message: Option<&'a RawValue>,
    raw: &'a str,
}

/// Read a window of the active branch of the session file at `path`.
///
/// `before` is the exclusive end offset into the renderable branch (defaults
/// to the branch end, i.e. the newest entries); `limit` caps the window size
/// (default 30). Returns the entries oldest-to-newest plus paging metadata.
/// `hasMore` is true when older entries exist before `start`.
pub fn read_session_page(
    path: &str,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<SessionPage, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("failed to read session file {path}: {e}"))?;
    Ok(page_from_session(&text, before, limit))
}

/// Core of read_session_page over in-memory session text (testable, no IO).
fn page_from_session(text: &str, before: Option<usize>, limit: Option<usize>) -> SessionPage {
    // Register every entry with an id as a chain node, keyed by id and kept
    // in file order. The engine and the desktop rename path both advance the
    // leaf through entries of any kind, so restricting the walk to messages
    // would truncate history at the first compaction / rename / model change.
    let mut order: Vec<&str> = Vec::new();
    let mut by_id: HashMap<&str, Node> = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(head) = serde_json::from_str::<LineHead>(trimmed) else {
            continue; // tolerate corrupt lines in an append-only file
        };
        let Some(id) = head.id else {
            continue;
        };
        // A repeated id (should not happen) keeps the first position.
        if by_id.contains_key(id) {
            continue;
        }
        by_id.insert(
            id,
            Node {
                kind: match head.kind.as_deref() {
                    Some("message") => NodeKind::Message,
                    Some("compaction") => NodeKind::Compaction,
                    _ => NodeKind::Connector,
                },
                parent_id: head.parent_id,
                message: head.message,
                raw: trimmed,
            },
        );
        order.push(id);
    }

    // Leaf of the active branch: the last chain node in file order.
    let chain: Vec<&Node> = match order.last().copied() {
        Some(leaf) => walk_branch(leaf, &by_id),
        None => Vec::new(),
    };

    // Renderable stream: messages verbatim, compactions as synthesized
    // compactionSummary entries; connectors only keep the chain walk going.
    let renderable: Vec<&Node> = chain
        .into_iter()
        .filter(|n| n.kind == NodeKind::Message || n.kind == NodeKind::Compaction)
        .collect();

    let total = renderable.len();
    let end = before.unwrap_or(total).min(total);
    let start = end.saturating_sub(limit.unwrap_or(30));

    let mut messages: Vec<serde_json::Value> = Vec::new();
    for node in &renderable[start..end] {
        let parsed = match node.kind {
            NodeKind::Message => node.message.and_then(|m| serde_json::from_str(m.get()).ok()),
            NodeKind::Compaction => compaction_summary(node.raw),
            NodeKind::Connector => None,
        };
        if let Some(value) = parsed {
            messages.push(value);
        }
    }

    SessionPage {
        messages,
        start,
        total,
        has_more: start > 0,
    }
}

/// Synthesize the compactionSummary message a compaction chain node maps to.
fn compaction_summary(raw: &str) -> Option<serde_json::Value> {
    #[derive(serde::Deserialize)]
    struct Fields {
        summary: Option<String>,
        #[serde(rename = "tokensBefore")]
        tokens_before: Option<i64>,
    }
    let fields: Fields = serde_json::from_str(raw).ok()?;
    let summary = fields.summary?;
    let mut value = serde_json::json!({ "role": "compactionSummary", "summary": summary });
    if let Some(tokens_before) = fields.tokens_before {
        value["tokensBefore"] = serde_json::json!(tokens_before);
    }
    Some(value)
}

/// Walk `parentId` links from `leaf` up to the chain break (null or unknown
/// parent), returning the chain oldest-to-newest. A visited set guards
/// against parent cycles in a corrupt file.
fn walk_branch<'a>(leaf: &str, by_id: &'a HashMap<&str, Node<'a>>) -> Vec<&'a Node<'a>> {
    let mut chain: Vec<&Node> = Vec::new();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut cursor: Option<&str> = Some(leaf);
    while let Some(id) = cursor {
        if !visited.insert(id) {
            break; // cycle
        }
        let Some(node) = by_id.get(id) else {
            break;
        };
        chain.push(node);
        cursor = node.parent_id;
    }
    chain.reverse();
    chain
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn message_line(id: &str, parent: &str, role: &str) -> String {
        json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "message": { "role": role, "content": [{"type": "text", "text": id}], "timestamp": 0 }
        })
        .to_string()
    }

    fn compaction_line(id: &str, parent: &str, summary: &str) -> String {
        json!({
            "type": "compaction",
            "id": id,
            "parentId": parent,
            "summary": summary,
            "tokensBefore": 1000,
            "timestamp": "2026-09-09T00:00:00.000Z"
        })
        .to_string()
    }

    /// Session text: two messages, a compaction mid-chain, a session_info
    /// tail node (the desktop rename path appends one) and a fork message
    /// that must NOT appear (not on the active branch). The active branch is
    /// whatever the last node in file order walks back to.
    fn session_text() -> String {
        let mut lines = vec![
            json!({ "type": "session", "version": 3, "id": "s1", "timestamp": "x", "cwd": "." }).to_string(),
            message_line("m1", "s1", "user"),
            message_line("fork", "m1", "user"), // sibling branch: not on the chain
            message_line("m2", "m1", "assistant"),
            compaction_line("c1", "m2", "## Goal\ncompacted"),
            message_line("m3", "c1", "user"),
            message_line("m4", "m3", "assistant"),
            json!({ "type": "session_info", "id": "i1", "parentId": "m4", "name": "renamed" }).to_string(),
        ];
        lines.push(String::new()); // tolerate a trailing blank line
        lines.join("\n")
    }

    fn roles(page: &SessionPage) -> Vec<String> {
        page.messages
            .iter()
            .filter_map(|m| m.get("role").and_then(|r| r.as_str()).map(str::to_owned))
            .collect()
    }

    #[test]
    fn compaction_mid_chain_keeps_history_and_becomes_summary() {
        let page = page_from_session(&session_text(), None, Some(100));
        // The active branch is m1..m4 plus the compaction node; the fork and
        // the session_info header/tail are not rendered.
        assert_eq!(roles(&page), vec!["user", "assistant", "compactionSummary", "user", "assistant"]);
        assert_eq!(page.total, 5);
        assert!(!page.has_more);

        let summary = &page.messages[2];
        assert_eq!(summary["summary"], json!("## Goal\ncompacted"));
        assert_eq!(summary["tokensBefore"], json!(1000));
    }

    #[test]
    fn paging_counts_renderable_entries() {
        let text = session_text();
        let total = page_from_session(&text, None, Some(100)).total;
        assert_eq!(total, 5);

        // A window of the last two renderable entries.
        let last = page_from_session(&text, None, Some(2));
        assert_eq!(roles(&last), vec!["user", "assistant"]);
        assert_eq!(last.start, 3);
        assert!(last.has_more);

        // Page the two oldest renderable entries.
        let older = page_from_session(&text, Some(2), Some(2));
        assert_eq!(roles(&older), vec!["user", "assistant"]);
        assert_eq!(older.start, 0);
        assert!(!older.has_more);
    }

    #[test]
    fn arbitrary_connector_nodes_do_not_truncate_the_chain() {
        // A model_change sitting mid-chain must keep both sides readable.
        let text = [
            message_line("m1", "s1", "user"),
            json!({ "type": "model_change", "id": "mc1", "parentId": "m1", "modelId": "x" }).to_string(),
            message_line("m2", "mc1", "assistant"),
        ]
        .join("\n");
        let page = page_from_session(&text, None, Some(100));
        assert_eq!(roles(&page), vec!["user", "assistant"]);
        assert_eq!(page.total, 2);
    }

    #[test]
    fn corrupt_or_header_lines_are_tolerated() {
        // A corrupt first line is skipped; an unknown parent (empty id link)
        // merely stops the walk where the chain reference breaks — entries
        // on the known part stay readable.
        let text = [
            "not json at all".to_string(),
            message_line("m1", "", "user"),
            message_line("m2", "m1", "assistant"),
        ]
        .join("\n");
        let page = page_from_session(&text, None, Some(100));
        assert_eq!(roles(&page), vec!["user", "assistant"]);
    }
}
