//! Paged reading of a pi session file for the history viewer.
//!
//! A session file is JSONL: after the `{"type":"session", ...}` header each
//! line is one entry. Message entries look like
//! `{"type":"message","id":"...","parentId":"...","message":{...}}` where
//! `parentId` links entries into a tree (forks create branches; the file is
//! append-only). The "current" conversation is the branch from the root down
//! to the last message entry in file order, found by walking `parentId`
//! backwards from that leaf.

use std::collections::{HashMap, HashSet};

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

/// Line-level view of one entry: only the branch-walk fields are parsed;
/// the `message` payload stays a borrowed raw slice so lines outside the
/// requested window never build a JSON DOM (they can be megabytes each).
#[derive(serde::Deserialize)]
struct LineEntry<'a> {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
}

/// One parsed message entry: its parent link and the raw `message` payload.
struct MessageEntry<'a> {
    parent_id: Option<String>,
    message: &'a RawValue,
}

/// Read a window of the active branch of the session file at `path`.
///
/// `before` is the exclusive end offset into the branch (defaults to the
/// branch end, i.e. the newest messages); `limit` caps the window size
/// (default 30). Returns the message payloads oldest-to-newest plus paging
/// metadata. `hasMore` is true when older messages exist before `start`.
pub fn read_session_page(
    path: &str,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<SessionPage, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read session file {path}: {e}"))?;

    // Collect message entries, keyed by id and kept in file order.
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, MessageEntry> = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<LineEntry>(trimmed) else {
            continue; // tolerate corrupt lines in an append-only file
        };
        if entry.kind.as_deref() != Some("message") {
            continue;
        }
        let (Some(id), Some(message)) = (entry.id, entry.message) else {
            continue;
        };
        // A repeated id (should not happen) keeps the latest payload but
        // stays at its first position in the order list.
        if !by_id.contains_key(&id) {
            order.push(id.clone());
        }
        by_id.insert(
            id,
            MessageEntry {
                parent_id: entry.parent_id,
                message,
            },
        );
    }

    // Leaf of the active branch: the last message entry in file order.
    // If it is somehow missing from the map, fall back to plain file order.
    let branch: Vec<&MessageEntry> = match order.last().and_then(|leaf| by_id.get(leaf)) {
        Some(_) => walk_branch(order.last().unwrap(), &by_id),
        None => order.iter().filter_map(|id| by_id.get(id)).collect(),
    };

    let total = branch.len();
    let end = before.unwrap_or(total).min(total);
    let start = end.saturating_sub(limit.unwrap_or(30));

    Ok(SessionPage {
        // Only the windowed messages get a full JSON parse.
        messages: branch[start..end]
            .iter()
            .filter_map(|entry| serde_json::from_str(entry.message.get()).ok())
            .collect(),
        start,
        total,
        has_more: start > 0,
    })
}

/// Walk `parentId` links from `leaf` up to the chain break (null or unknown
/// parent), returning the branch oldest-to-newest. A visited set guards
/// against parent cycles in a corrupt file.
fn walk_branch<'a>(
    leaf: &str,
    by_id: &'a HashMap<String, MessageEntry<'a>>,
) -> Vec<&'a MessageEntry<'a>> {
    let mut chain: Vec<&MessageEntry> = Vec::new();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut cursor: Option<&str> = Some(leaf);
    while let Some(id) = cursor {
        if !visited.insert(id) {
            break; // cycle
        }
        let Some(entry) = by_id.get(id) else {
            break;
        };
        chain.push(entry);
        cursor = entry.parent_id.as_deref();
    }
    chain.reverse();
    chain
}
