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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub messages: Vec<serde_json::Value>,
    pub start: usize,
    pub total: usize,
    pub has_more: bool,
}

/// One parsed message entry: its parent link and the raw `message` payload.
struct MessageEntry {
    parent_id: Option<String>,
    message: serde_json::Value,
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
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue; // tolerate corrupt lines in an append-only file
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(id) = value.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let Some(message) = value.get("message").cloned() else {
            continue;
        };
        let parent_id = value
            .get("parentId")
            .and_then(|p| p.as_str())
            .map(|p| p.to_string());
        let id = id.to_string();
        // A repeated id (should not happen) keeps the latest payload but
        // stays at its first position in the order list.
        if !by_id.contains_key(&id) {
            order.push(id.clone());
        }
        by_id.insert(
            id,
            MessageEntry {
                parent_id,
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
        messages: branch[start..end]
            .iter()
            .map(|entry| entry.message.clone())
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
    by_id: &'a HashMap<String, MessageEntry>,
) -> Vec<&'a MessageEntry> {
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
