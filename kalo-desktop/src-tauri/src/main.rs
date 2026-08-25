//! Kalo desktop backend.
//!
//! Drives pi engine subprocesses (`pi --mode rpc`) per chat session and
//! serves historical session listings to the frontend.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod gateway;
mod git;
mod internal_skills;
mod knowledge;
mod market_env;
mod mcp;
mod memory;
mod onboarding;
mod session;
mod session_paging;
mod sessions_store;
mod pi_config;
mod proc;
mod skills;

use files::{AttachmentData, DirDiff, DirEntry, FileText, TextSince};
use gateway::GatewayManager;
use git::GitStatus;
use internal_skills::InstallReport;
use session::{PiProcess, SessionManager};
use session_paging::SessionPage;
use sessions_store::ProjectGroup;
use skills::SkillMeta;
use tauri::{AppHandle, Manager, State};

/// Create a new chat session: spawn `pi --mode rpc` in `cwd` and return
/// the generated session id used in `pi-*:{session_id}` event names.
///
/// `(async)` on this and the other IO-heavy commands below moves the body off
/// the main thread (= the window event loop), so process spawns and directory
/// scans can no longer freeze the UI.
#[tauri::command(async)]
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
/// Stays on the main thread on purpose: the body only takes a lock and pushes
/// onto the writer thread's channel (no IO), and running it inline preserves
/// the order in which the frontend issued its commands.
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
#[tauri::command(async)]
fn close_session(session_id: String, state: State<SessionManager>) -> Result<(), String> {
    let mut sessions = lock_sessions(&state)?;
    if let Some(mut process) = sessions.remove(&session_id) {
        process.kill();
    }
    Ok(())
}

/// List historical sessions from ~/.kalo/agent/sessions, grouped by cwd.
#[tauri::command(async)]
fn list_sessions() -> Result<Vec<ProjectGroup>, String> {
    sessions_store::list_sessions()
}

/// Job center snapshot (P1-B): running engine sessions plus the gateway's
/// scheduled-task table, unified into one list for the top-bar panel.
#[tauri::command]
fn jobs_list(
    state: State<SessionManager>,
    gateway: State<GatewayManager>,
) -> Result<serde_json::Value, String> {
    use serde::Serialize;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RunningSession {
        id: String,
        kind: &'static str,
        name: String,
        source: String,
        cwd: String,
        state: &'static str,
        started_at: String,
    }

    let mut running: Vec<RunningSession> = Vec::new();
    {
        let sessions = lock_sessions(&state)?;
        for (id, process) in sessions.iter() {
            running.push(RunningSession {
                id: id.clone(),
                kind: "session",
                name: format!("{} 会话", if process.source == "gateway" { "定时" } else { "桌面" }),
                source: process.source.clone(),
                cwd: process.cwd.clone(),
                state: "running",
                started_at: process.started_at.clone(),
            });
        }
    }

    let tasks = gateway.schedules_snapshot();
    Ok(serde_json::json!({ "running": running, "tasks": tasks }))
}

/// Delete one historical session file (guarded to the sessions root).
#[tauri::command(async)]
fn delete_session(path: String) -> Result<(), String> {
    sessions_store::delete_session(&path)
}

/// Rename one historical session by appending a session_info entry
/// (equivalent to the engine's set_session_name, without a live engine).
#[tauri::command(async)]
fn rename_session(path: String, name: String) -> Result<(), String> {
    sessions_store::rename_session(&path, &name)
}

/// Read one page of a session file's active branch for the history viewer.
/// `before` is the exclusive end offset (default: branch end), `limit` the
/// window size (default 30); results come oldest-to-newest.
#[tauri::command(async)]
fn read_session_page(
    path: String,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<SessionPage, String> {
    session_paging::read_session_page(&path, before, limit)
}

/// List skills from ~/.kalo/skills (user scope) and, when `cwd` is
/// given, <cwd>/.kalo/skills (project scope).
#[tauri::command(async)]
fn list_skills(cwd: Option<String>) -> Result<Vec<SkillMeta>, String> {
    skills::list_skills(cwd.as_deref())
}

/// Read a skill file verbatim.
#[tauri::command(async)]
fn read_skill(path: String) -> Result<String, String> {
    skills::read_skill(&path)
}

/// Overwrite a skill file.
#[tauri::command(async)]
fn write_skill(path: String, content: String) -> Result<(), String> {
    skills::write_skill(&path, &content)
}

/// Create a directory skill with a frontmatter template. `scope` is "user"
/// or "project" (project requires `cwd`). Returns the new SKILL.md path.
#[tauri::command(async)]
fn create_skill(name: String, scope: String, cwd: Option<String>) -> Result<String, String> {
    skills::create_skill(&name, &scope, cwd.as_deref())
}

/// Delete a skill file or skill directory, restricted to pi skills roots.
#[tauri::command(async)]
fn delete_skill(path: String) -> Result<(), String> {
    skills::delete_skill(&path)
}

/// Re-install the bundled `internal-skills/` into ~/.kalo/skills, forcing the
/// bundled version over local edits.
#[tauri::command(async)]
fn reinstall_internal_skills() -> Result<InstallReport, String> {
    internal_skills::install(true)
}

/// Which interpreter `~/.kalo/market/py` resolves to, and whether the
/// market-data dependencies are installed there.
#[tauri::command(async)]
fn market_env_status() -> Result<market_env::MarketEnv, String> {
    market_env::status()
}

/// List personal memories from ~/.kalo/memory (frontmatter + summary).
#[tauri::command(async)]
fn list_memories() -> Result<Vec<memory::MemoryMeta>, String> {
    memory::list_memories()
}

/// Read one memory by slug.
#[tauri::command(async)]
fn read_memory(slug: String) -> Result<memory::MemoryEntry, String> {
    memory::read_memory(&slug)
}

/// Create or overwrite a memory; returns the slug. `slug` None derives one
/// from the title.
#[tauri::command(async)]
fn write_memory(
    slug: Option<String>,
    title: String,
    tags: Vec<String>,
    content: String,
) -> Result<String, String> {
    memory::write_memory(slug.as_deref(), &title, &tags, &content)
}

/// Delete a memory by slug, restricted to the memory root.
#[tauri::command(async)]
fn delete_memory(slug: String) -> Result<(), String> {
    memory::delete_memory(&slug)
}

/// Read ~/.kalo/agent/models.json (custom provider definitions).
#[tauri::command(async)]
fn read_models_config() -> Result<serde_json::Value, String> {
    pi_config::read_models_config()
}

/// Write ~/.kalo/agent/models.json. Takes effect for newly spawned sessions.
#[tauri::command(async)]
fn write_models_config(config: serde_json::Value) -> Result<(), String> {
    pi_config::write_models_config(&config)
}

/// Read ~/.kalo/agent/auth.json (provider API keys / OAuth tokens).
#[tauri::command(async)]
fn read_auth_config() -> Result<serde_json::Value, String> {
    pi_config::read_auth_config()
}

/// Write ~/.kalo/agent/auth.json. Takes effect for newly spawned sessions.
#[tauri::command(async)]
fn write_auth_config(config: serde_json::Value) -> Result<(), String> {
    pi_config::write_auth_config(&config)
}

/// List one directory level for the file panel (dirs first, name-sorted).
#[tauri::command(async)]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    files::list_dir(&path)
}

/// Read a file as capped text for preview (binary files flagged, not read).
#[tauri::command(async)]
fn read_file_text(path: String, max_bytes: Option<usize>) -> Result<FileText, String> {
    files::read_file_text(&path, max_bytes)
}

/// Git status of the repository containing `cwd`, for the file panel.
/// `None` means "not a repository" (or git is missing) — a normal state.
#[tauri::command(async)]
fn git_status(cwd: String) -> Result<Option<GitStatus>, String> {
    git::git_status(&cwd)
}

/// Working-tree diff of one file against HEAD (staged + unstaged together).
#[tauri::command(async)]
fn git_diff(cwd: String, rel_path: String) -> Result<String, String> {
    git::git_diff(&cwd, &rel_path)
}

/// Stable paths the frontend needs to build commands: the user's home, the
/// `~/.kalo` root, and the engine binary this app ships. Generic — nothing
/// here knows what the caller intends to do with them.
#[tauri::command(async)]
fn app_paths() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    let kalo_root = std::path::PathBuf::from(&home).join(".kalo");
    // A missing engine binary is not fatal here: the caller may only want the
    // paths, and it will get a clear error when it actually tries to spawn.
    let engine = session::engine_binary_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "home": home,
        "kaloRoot": kalo_root.to_string_lossy(),
        "engineBin": engine,
    }))
}

/// Incremental tail of an append-only file: everything from `offset` to EOF,
/// plus the offset to resume from. Generic — any growing log can use it.
#[tauri::command(async)]
fn read_text_since(
    path: String,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<TextSince, String> {
    files::read_text_since(&path, offset, max_bytes)
}

/// Relative paths that differ between two directory trees (added / removed /
/// changed). Generic "what changed between these two copies" primitive.
#[tauri::command(async)]
fn dir_diff_names(a: String, b: String, ignore: Option<Vec<String>>) -> Result<DirDiff, String> {
    files::dir_diff_names(&a, &b, &ignore.unwrap_or_default())
}

/// Read a file as a chat attachment: inline base64 for images, a bare path
/// for everything else (the model reads it itself).
#[tauri::command(async)]
fn read_attachment(path: String) -> Result<AttachmentData, String> {
    files::read_attachment(&path)
}

/// Persist a pasted attachment — the webview hands it over as bytes without a
/// path — under `~/.kalo/attachments` and return where it landed.
#[tauri::command(async)]
fn save_attachment_bytes(name: String, data_base64: String) -> Result<AttachmentData, String> {
    files::save_attachment_bytes(&name, &data_base64)
}

/// Open a path with the system default app, or reveal it in the OS file
/// manager (reveal = true).
#[tauri::command(async)]
fn open_path(path: String, reveal: bool) -> Result<(), String> {
    files::open_path(&path, reveal)
}

/// Search entry names under `root` (substring, case-insensitive) for the
/// input box's @ file completion.
#[tauri::command(async)]
fn search_files(root: String, query: String, limit: Option<usize>) -> Result<Vec<files::FileMatch>, String> {
    files::search_files(&root, &query, limit)
}

// ============================================================================
// IM gateway (Feishu sidecar)
// ============================================================================

/// Begin Feishu QR pairing: spawn the gateway sidecar if needed.
#[tauri::command(async)]
fn gateway_pair_start(state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.pair_start(&app)
}

/// Cancel an in-flight pairing attempt.
#[tauri::command(async)]
fn gateway_pair_cancel(state: State<GatewayManager>) -> Result<(), String> {
    state.pair_cancel()
}

/// Current gateway status snapshot.
#[tauri::command]
fn gateway_status(state: State<GatewayManager>) -> gateway::GatewayStatusData {
    state.status()
}

/// Delete stored Feishu credentials and stop the gateway.
#[tauri::command(async)]
fn gateway_unbind(state: State<GatewayManager>) -> Result<(), String> {
    state.unbind()
}

// ============================================================================
// Scheduler (task table lives in the gateway sidecar)
// ============================================================================

/// Create or replace a scheduled task (validated gateway-side; a
/// `schedule-error` event is emitted on invalid input).
#[tauri::command(async)]
fn schedule_upsert(
    task: serde_json::Value,
    state: State<GatewayManager>,
    app: AppHandle,
) -> Result<(), String> {
    state.schedule_upsert(&app, task)
}

/// Remove a scheduled task by id.
#[tauri::command(async)]
fn schedule_remove(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.schedule_remove(&app, &id)
}

/// Manually trigger a task now (ignores enabled/cooldown).
#[tauri::command(async)]
fn schedule_run(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.schedule_run(&app, &id)
}

/// Cached task-table snapshot (fresh data arrives via `schedule-status`).
#[tauri::command]
fn schedule_list(state: State<GatewayManager>) -> Vec<serde_json::Value> {
    state.schedule_list()
}

// ============================================================================
// Feeds (declarative periodic pulls; engine lives in the gateway sidecar)
// ============================================================================

/// Create or replace a feed spec (validation errors arrive as `feed-error`).
#[tauri::command(async)]
fn feed_upsert(
    spec: serde_json::Value,
    state: State<GatewayManager>,
    app: AppHandle,
) -> Result<(), String> {
    state.feed_upsert(&app, spec)
}

/// Delete a feed and its cached snapshot.
#[tauri::command(async)]
fn feed_remove(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.feed_remove(&app, &id)
}

/// Pull one feed right now (ignores enabled and backoff).
#[tauri::command(async)]
fn feed_run(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<(), String> {
    state.feed_run(&app, &id)
}

/// Cached feed table (fresh data arrives via `feed-status`).
#[tauri::command]
fn feed_list(state: State<GatewayManager>) -> Vec<serde_json::Value> {
    state.feed_list()
}

// ============================================================================
// Job runtime (registry lives in the gateway sidecar, P0-1)
// ============================================================================

/// Start a background job (label/cwd/cmd plus optional gate/health/rules).
#[tauri::command(async)]
fn job_start(job: serde_json::Value, state: State<GatewayManager>, app: AppHandle) -> Result<String, String> {
    state.job_start(&app, job)
}

/// Fresh job list from the gateway (also refreshes the cached snapshot).
#[tauri::command(async)]
fn job_list(state: State<GatewayManager>, app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    state.job_list(&app)
}

/// Cached job list, for the panel's first paint without a round-trip.
#[tauri::command]
fn job_snapshot(state: State<GatewayManager>) -> Vec<serde_json::Value> {
    state.jobs_snapshot()
}

/// Consuming read of a job's new output.
#[tauri::command(async)]
fn job_logs(id: String, state: State<GatewayManager>, app: AppHandle) -> Result<String, String> {
    state.job_logs(&app, &id)
}

/// Stop a job; returns "requested" or "already-finished".
#[tauri::command(async)]
fn job_stop(
    id: String,
    reason: Option<String>,
    state: State<GatewayManager>,
    app: AppHandle,
) -> Result<String, String> {
    state.job_stop(&app, &id, reason)
}

/// Metrics a job's rules extracted from its output (newest `tail` entries).
#[tauri::command(async)]
fn job_metrics(
    id: String,
    tail: Option<u32>,
    state: State<GatewayManager>,
    app: AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    state.job_metrics(&app, &id, tail)
}

// ============================================================================
// Knowledge base (~/.kalo/knowledge, P0-B)
// ============================================================================

/// List all knowledge cards (frontmatter metadata), newest first.
#[tauri::command(async)]
fn list_knowledge_cards() -> Result<Vec<knowledge::KnowledgeCardMeta>, String> {
    knowledge::list_cards()
}

/// List the domains (= top-level directories), decorated with the optional
/// `_types/<domain>.md` presentation note.
#[tauri::command(async)]
fn list_knowledge_domains() -> Result<Vec<knowledge::KnowledgeDomain>, String> {
    knowledge::list_domains()
}

/// Case-insensitive substring search over card bodies and frontmatter.
#[tauri::command(async)]
fn search_knowledge(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<knowledge::KnowledgeSearchHit>, String> {
    knowledge::search_cards(&query, limit)
}

/// Read one card by its root-relative path.
#[tauri::command(async)]
fn read_knowledge_card(rel_path: String) -> Result<String, String> {
    knowledge::read_card(&rel_path)
}

/// Create (rel_path None → `<domain>/<slug>.md`) or overwrite a card;
/// returns the rel path.
#[tauri::command(async)]
fn write_knowledge_card(
    rel_path: Option<String>,
    domain: String,
    title: String,
    content: String,
) -> Result<String, String> {
    knowledge::write_card(rel_path.as_deref(), &domain, &title, &content)
}

/// Delete a card by rel path.
#[tauri::command(async)]
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
            // First-run: knowledge base directory tree + INDEX.md stub.
            knowledge::ensure_knowledge_base();
            // Bundled skills → ~/.kalo/skills (keeps locally edited ones).
            match internal_skills::install(false) {
                Ok(report) => {
                    if !report.installed.is_empty() || !report.updated.is_empty() {
                        eprintln!(
                            "[internal-skills] installed {} / updated {} / skipped {}",
                            report.installed.len(),
                            report.updated.len(),
                            report.skipped.len()
                        );
                    }
                }
                Err(err) => eprintln!("[internal-skills] {err}"),
            }
            // The `~/.kalo/market/py` entry point the market-data skill, the
            // daily snapshot task and the user's terminal all go through.
            // Filesystem-only, so it stays on the startup path; the probe that
            // actually runs an interpreter is on demand (`market_env_status`).
            match market_env::ensure_shim() {
                Ok(state) => eprintln!("[market-env] shim {state:?}"),
                Err(err) => eprintln!("[market-env] {err}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            send_command,
            close_session,
            list_sessions,
            delete_session,
            rename_session,
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
            reinstall_internal_skills,
            market_env_status,
            list_memories,
            read_memory,
            write_memory,
            delete_memory,
            list_dir,
            read_file_text,
            git_status,
            git_diff,
            app_paths,
            read_text_since,
            dir_diff_names,
            read_attachment,
            save_attachment_bytes,
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
            feed_upsert,
            feed_remove,
            feed_run,
            feed_list,
            job_start,
            job_list,
            job_snapshot,
            job_logs,
            job_stop,
            job_metrics,
            list_knowledge_cards,
            list_knowledge_domains,
            search_knowledge,
            read_knowledge_card,
            write_knowledge_card,
            delete_knowledge_card,
            mcp::read_mcp_config,
            mcp::write_mcp_config,
            mcp::read_mcp_status,
            onboarding::read_onboarding_state,
            onboarding::write_onboarding_state,
            jobs_list,
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
