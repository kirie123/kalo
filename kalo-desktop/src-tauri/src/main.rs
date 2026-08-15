//! Kalo desktop backend.
//!
//! Drives pi engine subprocesses (`pi --mode rpc`) per chat session and
//! serves historical session listings to the frontend.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod gateway;
mod knowledge;
mod memory;
mod session;
mod session_paging;
mod sessions_store;
mod pi_config;
mod skills;

use files::{AttachmentData, DirEntry, FileText};
use gateway::GatewayManager;
use session::{PiProcess, SessionManager};
use session_paging::SessionPage;
use sessions_store::ProjectGroup;
use skills::SkillMeta;
use tauri::{AppHandle, Manager, State};

/// Create a new chat session: spawn `pi --mode rpc` in `cwd` and return
/// the generated session id used in `pi-*:{session_id}` event names.
#[tauri::command]
fn create_session(
    cwd: String,
    state: State<SessionManager>,
    app: AppHandle,
) -> Result<String, String> {
    let session_id = gen_session_id();
    let process = PiProcess::spawn(&session_id, &cwd, app)?;
    lock_sessions(&state)?.insert(session_id.clone(), process);
    Ok(session_id)
}

/// Forward one RPC command object to the session's pi process stdin.
#[tauri::command]
fn send_command(
    session_id: String,
    command: serde_json::Value,
    state: State<SessionManager>,
) -> Result<(), String> {
    let sessions = lock_sessions(&state)?;
    let process = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?;
    process.send(command.to_string())
}

/// Kill the pi process for a session and drop it from the registry.
/// Closing an already-unknown session is a no-op.
#[tauri::command]
fn close_session(session_id: String, state: State<SessionManager>) -> Result<(), String> {
    let mut sessions = lock_sessions(&state)?;
    if let Some(mut process) = sessions.remove(&session_id) {
        process.kill();
    }
    Ok(())
}

/// List historical sessions from ~/.kalo/agent/sessions, grouped by cwd.
#[tauri::command]
fn list_sessions() -> Result<Vec<ProjectGroup>, String> {
    sessions_store::list_sessions()
}

/// Delete one historical session file (guarded to the sessions root).
#[tauri::command]
fn delete_session(path: String) -> Result<(), String> {
    sessions_store::delete_session(&path)
}

/// Read one page of a session file's active branch for the history viewer.
/// `before` is the exclusive end offset (default: branch end), `limit` the
/// window size (default 30); results come oldest-to-newest.
#[tauri::command]
fn read_session_page(
    path: String,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<SessionPage, String> {
    session_paging::read_session_page(&path, before, limit)
}

/// List skills from ~/.kalo/skills (user scope) and, when `cwd` is
/// given, <cwd>/.kalo/skills (project scope).
#[tauri::command]
fn list_skills(cwd: Option<String>) -> Result<Vec<SkillMeta>, String> {
    skills::list_skills(cwd.as_deref())
}

/// Read a skill file verbatim.
#[tauri::command]
fn read_skill(path: String) -> Result<String, String> {
    skills::read_skill(&path)
}

/// Overwrite a skill file.
#[tauri::command]
fn write_skill(path: String, content: String) -> Result<(), String> {
    skills::write_skill(&path, &content)
}

/// Create a directory skill with a frontmatter template. `scope` is "user"
/// or "project" (project requires `cwd`). Returns the new SKILL.md path.
#[tauri::command]
fn create_skill(name: String, scope: String, cwd: Option<String>) -> Result<String, String> {
    skills::create_skill(&name, &scope, cwd.as_deref())
}

/// Delete a skill file or skill directory, restricted to pi skills roots.
#[tauri::command]
fn delete_skill(path: String) -> Result<(), String> {
    skills::delete_skill(&path)
}

/// List personal memories from ~/.kalo/memory (frontmatter + summary).
#[tauri::command]
fn list_memories() -> Result<Vec<memory::MemoryMeta>, String> {
    memory::list_memories()
}

/// Read one memory by slug.
#[tauri::command]
fn read_memory(slug: String) -> Result<memory::MemoryEntry, String> {
    memory::read_memory(&slug)
}

/// Create or overwrite a memory; returns the slug. `slug` None derives one
/// from the title.
#[tauri::command]
fn write_memory(
    slug: Option<String>,
    title: String,
    tags: Vec<String>,
    content: String,
) -> Result<String, String> {
    memory::write_memory(slug.as_deref(), &title, &tags, &content)
}

/// Delete a memory by slug, restricted to the memory root.
#[tauri::command]
fn delete_memory(slug: String) -> Result<(), String> {
    memory::delete_memory(&slug)
}

/// Read ~/.kalo/agent/models.json (custom provider definitions).
#[tauri::command]
fn read_models_config() -> Result<serde_json::Value, String> {
    pi_config::read_models_config()
}

/// Write ~/.kalo/agent/models.json. Takes effect for newly spawned sessions.
#[tauri::command]
fn write_models_config(config: serde_json::Value) -> Result<(), String> {
    pi_config::write_models_config(&config)
}

/// Read ~/.kalo/agent/auth.json (provider API keys / OAuth tokens).
#[tauri::command]
fn read_auth_config() -> Result<serde_json::Value, String> {
    pi_config::read_auth_config()
}

/// Write ~/.kalo/agent/auth.json. Takes effect for newly spawned sessions.
#[tauri::command]
fn write_auth_config(config: serde_json::Value) -> Result<(), String> {
    pi_config::write_auth_config(&config)
}

/// List one directory level for the file panel (dirs first, name-sorted).
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    files::list_dir(&path)
}

/// Read a file as capped text for preview (binary files flagged, not read).
#[tauri::command]
fn read_file_text(path: String, max_bytes: Option<usize>) -> Result<FileText, String> {
    files::read_file_text(&path, max_bytes)
}

/// Read a file as a chat attachment (image base64 or extracted text).
#[tauri::command]
fn read_attachment(path: String) -> Result<AttachmentData, String> {
    files::read_attachment(&path)
}

/// Open a path with the system default app, or reveal it in the OS file
/// manager (reveal = true).
#[tauri::command]
fn open_path(path: String, reveal: bool) -> Result<(), String> {
    files::open_path(&path, reveal)
}

/// Search entry names under `root` (substring, case-insensitive) for the
/// input box's @ file completion.
#[tauri::command]
fn search_files(root: String, query: String, limit: Option<usize>) -> Result<Vec<files::FileMatch>, String> {
    files::search_files(&root, &query, limit)
}

// ============================================================================
// IM gateway (Feishu sidecar)
// ============================================================================

/// Begin Feishu QR pairing: spawn the gateway sidecar if needed.
#[tauri::command]
fn gateway_pair_start(state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.pair_start(&app)
}

/// Cancel an in-flight pairing attempt.
#[tauri::command]
fn gateway_pair_cancel(state: State<GatewayManager>) -> Result<(), String> {
    state.pair_cancel()
}

/// Current gateway status snapshot.
#[tauri::command]
fn gateway_status(state: State<GatewayManager>) -> gateway::GatewayStatusData {
    state.status()
}

/// Delete stored Feishu credentials and stop the gateway.
#[tauri::command]
fn gateway_unbind(state: State<GatewayManager>) -> Result<(), String> {
    state.unbind()
}

// ============================================================================
// Scheduler (task table lives in the gateway sidecar)
// ============================================================================

/// Create or replace a scheduled task (validated gateway-side; a
/// `schedule-error` event is emitted on invalid input).
#[tauri::command]
fn schedule_upsert(
    task: serde_json::Value,
    state: State<GatewayManager>,
    app: AppHandle,
) -> Result<(), String> {
    state.schedule_upsert(&app, task)
}

/// Remove a scheduled task by id.
#[tauri::command]
fn schedule_remove(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.schedule_remove(&app, &id)
}

/// Manually trigger a task now (ignores enabled/cooldown).
#[tauri::command]
fn schedule_run(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.schedule_run(&app, &id)
}

/// Cached task-table snapshot (fresh data arrives via `schedule-status`).
#[tauri::command]
fn schedule_list(state: State<GatewayManager>) -> Vec<serde_json::Value> {
    state.schedule_list()
}

// ============================================================================
// Knowledge base (~/.kalo/knowledge, P0-B)
// ============================================================================

/// List all knowledge cards (frontmatter metadata), newest first.
#[tauri::command]
fn list_knowledge_cards() -> Result<Vec<knowledge::KnowledgeCardMeta>, String> {
    knowledge::list_cards()
}

/// Read one card by its root-relative path.
#[tauri::command]
fn read_knowledge_card(rel_path: String) -> Result<String, String> {
    knowledge::read_card(&rel_path)
}

/// Create (rel_path None → `<domain>/<slug>.md`) or overwrite a card;
/// returns the rel path.
#[tauri::command]
fn write_knowledge_card(
    rel_path: Option<String>,
    domain: String,
    title: String,
    content: String,
) -> Result<String, String> {
    knowledge::write_card(rel_path.as_deref(), &domain, &title, &content)
}

/// Delete a card by rel path.
#[tauri::command]
fn delete_knowledge_card(rel_path: String) -> Result<(), String> {
    knowledge::delete_card(&rel_path)
}

fn lock_sessions<'a>(
    state: &'a State<SessionManager>,
) -> Result<std::sync::MutexGuard<'a, std::collections::HashMap<String, PiProcess>>, String> {
    state
        .sessions
        .lock()
        .map_err(|e| format!("session manager lock poisoned: {e}"))
}

/// Generate a uuid-style id without an external crate: 16 bytes of
/// material mixed from the current time and a process-wide counter.
pub(crate) fn gen_session_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);

    let a = nanos ^ (counter.wrapping_add(1)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let b = nanos.rotate_left(32) ^ counter.wrapping_mul(0xD1B5_4A32_D192_ED03);

    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a as u16,
        (b >> 48) as u16,
        b & 0xFFFF_FFFF_FFFF
    )
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::default())
        .manage(GatewayManager::default())
        .setup(|app| {
            // Auto-start the IM gateway when Feishu credentials already exist.
            gateway::autostart(app.handle());
            // First-run: knowledge base dirs + starter skill (non-destructive).
            knowledge::ensure_knowledge_base();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            send_command,
            close_session,
            list_sessions,
            delete_session,
            read_session_page,
            read_models_config,
            write_models_config,
            read_auth_config,
            write_auth_config,
            list_skills,
            read_skill,
            write_skill,
            create_skill,
            delete_skill,
            list_memories,
            read_memory,
            write_memory,
            delete_memory,
            list_dir,
            read_file_text,
            read_attachment,
            open_path,
            search_files,
            gateway_pair_start,
            gateway_pair_cancel,
            gateway_status,
            gateway_unbind,
            schedule_upsert,
            schedule_remove,
            schedule_run,
            schedule_list,
            list_knowledge_cards,
            read_knowledge_card,
            write_knowledge_card,
            delete_knowledge_card,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kalo");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Reap child processes so nothing outlives the app window.
            if let Some(gateway) = app_handle.try_state::<GatewayManager>() {
                gateway.shutdown();
            }
            if let Some(sessions) = app_handle.try_state::<SessionManager>() {
                if let Ok(mut map) = sessions.sessions.lock() {
                    for (_, mut process) in map.drain() {
                        process.kill();
                    }
                }
            }
        }
    });
}
