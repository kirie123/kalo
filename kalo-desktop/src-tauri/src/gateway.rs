//! IM gateway sidecar management (Feishu).
//!
//! The gateway is an independent executable (`kalo-gateway`) speaking the
//! same NDJSON-over-stdio protocol as the pi engine:
//!
//! Rust → gateway (stdin, one JSON object per line):
//!   {"cmd":"pair_start"} / {"cmd":"pair_cancel"} / {"cmd":"unbind"}
//!   {"cmd":"event","sessionId":"...","cwd":"...","payload":{...PiEvent...}}
//!   {"cmd":"session_exit","sessionId":"...","code":0}
//!
//! gateway → Rust (stdout):
//!   {"type":"pair_qr","qrDataUrl":"data:image/png;base64,...","expiresIn":300}
//!   {"type":"status","state":"connecting|connected|disconnected","user":"ou_..."}
//!   {"type":"error","message":"..."}
//!
//! Job runtime (P0-1) rides the same pipe as a request/reply pair:
//!   Rust → {"cmd":"job_status","requestId":"desk-1"}
//!   gateway → {"type":"job_reply","requestId":"desk-1","ok":true,"jobs":[...]}
//! plus unsolicited {"type":"job_event","event":"changed|done"} notices that
//! trigger a refresh and the `job-status` / `job-done` Tauri events.
//!
//! Feeds (declarative periodic pulls) follow the scheduler's shape: the table
//! lives in the sidecar, `feed_*` commands are pass-throughs, and every value
//! change arrives as {"type":"feed_status","feeds":[...]} → `feed-status`.
//!
//! Every state change is cached here and pushed to the frontend as the
//! `gateway-status` Tauri event. Engine events are forwarded best-effort:
//! with no gateway running the forward is a cheap mutex check and a drop.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::session::{NdjsonFramer, PiProcess, SessionManager};

const SIDECAR: &str = "kalo-gateway-x86_64-pc-windows-msvc.exe";
/// Auto-restart budget for a crashed gateway that should be connected.
const MAX_RESTARTS: u32 = 5;

/// Cached gateway status, also the `gateway-status` event payload.
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatusData {
    pub state: String,
    pub user: Option<String>,
    pub message: Option<String>,
    pub qr_data_url: Option<String>,
    pub expires_in: Option<u64>,
}

impl GatewayStatusData {
    fn new(state: &str) -> Self {
        Self { state: state.to_string(), ..Default::default() }
    }
}

/// Managed singleton guarding the gateway child process.
#[derive(Default)]
pub struct GatewayManager {
    inner: Mutex<GatewayInner>,
}

struct GatewayInner {
    process: Option<GatewayProcess>,
    status: GatewayStatusData,
    /// Restart attempts after an unexpected exit; reset once connected.
    restart_attempts: u32,
    /// True while the sidecar is expected to stay alive (paired/connected).
    want_running: bool,
    /// True during deliberate stop (unbind/shutdown) — no auto-restart.
    stopping: bool,
    /// Latest scheduler task-table snapshot (P0-A), pushed by the gateway.
    schedules: Vec<serde_json::Value>,
    /// Latest feed table snapshot (declarative periodic pulls).
    feeds: Vec<serde_json::Value>,
    /// Latest job snapshot (P0-1); refreshed whenever the gateway says so.
    jobs: Vec<serde_json::Value>,
    /// In-flight job requests, keyed by requestId (the gateway echoes it back).
    job_waiters: HashMap<String, mpsc::Sender<Result<serde_json::Value, String>>>,
    /// Monotonic source of requestIds.
    job_seq: u64,
}

impl GatewayInner {
    fn take_schedules(&self) -> Vec<serde_json::Value> {
        self.schedules.clone()
    }
}

impl GatewayManager {
    /// Latest scheduler snapshot for the job center (P1-B).
    pub fn schedules_snapshot(&self) -> Vec<serde_json::Value> {
        self.lock().take_schedules()
    }
}

impl Default for GatewayInner {
    fn default() -> Self {
        Self {
            process: None,
            status: GatewayStatusData::new("disconnected"),
            restart_attempts: 0,
            want_running: false,
            stopping: false,
            schedules: Vec::new(),
            feeds: Vec::new(),
            jobs: Vec::new(),
            job_waiters: HashMap::new(),
            job_seq: 0,
        }
    }
}

struct GatewayProcess {
    child: Arc<Mutex<Child>>,
    stdin_tx: mpsc::Sender<String>,
}

impl GatewayManager {
    /// Lock the inner state, recovering from poisoning (a panicked thread
    /// must not take down gateway management for the rest of the session).
    fn lock(&self) -> std::sync::MutexGuard<'_, GatewayInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Spawn the gateway sidecar unless one is already running. Emits the
    /// initial status and returns an error when the binary is missing.
    pub fn ensure_spawned(&self, app: &AppHandle) -> Result<(), String> {
        {
            let inner = self.lock();
            if inner.process.is_some() {
                return Ok(());
            }
            if inner.stopping {
                return Err("gateway is shutting down".into());
            }
        }

        let path = match resolve_gateway_path() {
            Ok(p) => p,
            Err(e) => {
                self.update_status(app, |s| {
                    *s = GatewayStatusData::new("unavailable");
                    s.message = Some(e.clone());
                });
                return Err(e);
            }
        };

        let mut cmd = Command::new(&path);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::proc::no_window(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", path.display()))?;

        let mut stdin = child.stdin.take().ok_or("gateway stdin was not piped")?;
        let mut stdout = child.stdout.take().ok_or("gateway stdout was not piped")?;
        let mut stderr = child.stderr.take().ok_or("gateway stderr was not piped")?;

        let (stdin_tx, stdin_rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in stdin_rx {
                let mut bytes = line.into_bytes();
                bytes.push(b'\n');
                if let Err(e) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
                    eprintln!("[kalo] gateway stdin write failed, stopping writer: {e}");
                    break;
                }
            }
        });

        // stdout reader: dispatch gateway messages to the status cache.
        {
            let app = app.clone();
            thread::spawn(move || {
                let mut framer = NdjsonFramer::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match stdout.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            for line in framer.push(&chunk[..n]) {
                                handle_gateway_line(&app, &line);
                            }
                        }
                        Err(e) => {
                            eprintln!("[kalo] gateway stdout read failed: {e}");
                            break;
                        }
                    }
                }
                if let Some(line) = framer.finish() {
                    handle_gateway_line(&app, &line);
                }
            });
        }

        // stderr reader: diagnostics only.
        thread::spawn(move || {
            let mut framer = NdjsonFramer::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        for line in framer.push(&chunk[..n]) {
                            eprintln!("[kalo-gateway] {line}");
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // exit watcher: cache cleanup + crash restart policy.
        let child_arc = Arc::new(Mutex::new(child));
        {
            let app = app.clone();
            let child_arc = Arc::clone(&child_arc);
            thread::spawn(move || {
                // Polls instead of blocking in `wait`, so `shutdown` can take
                // the lock while the sidecar is still alive. See `proc.rs`.
                let code = crate::proc::wait_released(&child_arc);
                on_gateway_exit(&app, code);
            });
        }

        let mut inner = self.lock();
        inner.process = Some(GatewayProcess { child: child_arc, stdin_tx });
        inner.want_running = true;
        inner.restart_attempts = 0;
        if inner.status.state != "pairing" {
            inner.status = GatewayStatusData::new("starting");
        }
        let snapshot = inner.status.clone();
        drop(inner);
        emit_status(app, &snapshot);
        Ok(())
    }

    /// Send one NDJSON line to the gateway stdin.
    fn send(&self, line: String) -> Result<(), String> {
        let inner = self.lock();
        match &inner.process {
            Some(p) => p
                .stdin_tx
                .send(line)
                .map_err(|e| format!("gateway stdin channel closed: {e}")),
            None => Err("gateway is not running".into()),
        }
    }

    fn send_cmd(&self, cmd: &str) -> Result<(), String> {
        self.send(format!("{{\"cmd\":\"{cmd}\"}}"))
    }

    /// Begin QR pairing (spawns the sidecar on demand).
    pub fn pair_start(&self, app: &AppHandle) -> Result<(), String> {
        self.ensure_spawned(app)?;
        self.send_cmd("pair_start")
    }

    pub fn pair_cancel(&self) -> Result<(), String> {
        self.send_cmd("pair_cancel")
    }

    /// Unbind: the gateway deletes its credentials and reports "disconnected".
    /// It stays running — the job runtime lives there too, so this is a
    /// logout, not a shutdown.
    pub fn unbind(&self) -> Result<(), String> {
        let result = self.send_cmd("unbind");
        if result.is_err() {
            // Gateway already gone — fall back to a local reset.
            let mut inner = self.lock();
            inner.want_running = false;
            inner.process = None;
            inner.status = GatewayStatusData::new("disconnected");
        }
        result
    }

    /// Forward one engine stdout line (already parsed) to the gateway.
    pub fn forward_event(&self, session_id: &str, cwd: &str, payload: &serde_json::Value) {
        let line = serde_json::json!({
            "cmd": "event",
            "sessionId": session_id,
            "cwd": cwd,
            "payload": payload,
        });
        let _ = self.send(line.to_string());
    }

    /// Tell the gateway an engine process exited (crash / restart).
    pub fn forward_exit(&self, session_id: &str, code: Option<i32>) {
        let line = serde_json::json!({
            "cmd": "session_exit",
            "sessionId": session_id,
            "code": code,
        });
        let _ = self.send(line.to_string());
    }

    // ------------------------------------------------------------------
    // Scheduler (P0-A): the task table lives in the gateway sidecar; the
    // frontend's commands are simple pass-throughs over the stdin channel.
    // ------------------------------------------------------------------

    /// Forward a scheduler/feed command, spawning the sidecar on demand (both
    /// must run even before Feishu is paired).
    fn send_sidecar_cmd(&self, app: &AppHandle, value: serde_json::Value) -> Result<(), String> {
        self.ensure_spawned(app)?;
        self.send(value.to_string())
    }

    pub fn schedule_upsert(&self, app: &AppHandle, task: serde_json::Value) -> Result<(), String> {
        self.send_sidecar_cmd(app, serde_json::json!({ "cmd": "schedule_upsert", "task": task }))
    }

    pub fn schedule_remove(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.send_sidecar_cmd(app, serde_json::json!({ "cmd": "schedule_remove", "id": id }))
    }

    pub fn schedule_run(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.send_sidecar_cmd(app, serde_json::json!({ "cmd": "schedule_run", "id": id }))
    }

    /// Cached task-table snapshot; also asks the gateway for a fresh copy
    /// (delivered asynchronously as the `schedule-status` event).
    pub fn schedule_list(&self) -> Vec<serde_json::Value> {
        let running = self.lock().process.is_some();
        if running {
            let _ = self.send(r#"{"cmd":"schedule_list"}"#.to_string());
        }
        self.lock().schedules.clone()
    }

    // ------------------------------------------------------------------
    // Feeds: same shape as the scheduler — the table lives in the sidecar,
    // these are pass-throughs plus a cached snapshot for the first paint.
    // ------------------------------------------------------------------

    pub fn feed_upsert(&self, app: &AppHandle, spec: serde_json::Value) -> Result<(), String> {
        self.send_sidecar_cmd(app, serde_json::json!({ "cmd": "feed_upsert", "spec": spec }))
    }

    pub fn feed_remove(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.send_sidecar_cmd(app, serde_json::json!({ "cmd": "feed_remove", "id": id }))
    }

    pub fn feed_run(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.send_sidecar_cmd(app, serde_json::json!({ "cmd": "feed_run", "id": id }))
    }

    /// Cached feed table; also requests a fresh copy (`feed-status` event).
    pub fn feed_list(&self) -> Vec<serde_json::Value> {
        let running = self.lock().process.is_some();
        if running {
            let _ = self.send(r#"{"cmd":"feed_list"}"#.to_string());
        }
        self.lock().feeds.clone()
    }

    // ------------------------------------------------------------------
    // Job runtime (P0-1): the registry lives in the gateway sidecar. Each
    // command carries a requestId; the reply arrives on the stdout reader
    // thread and is handed back through a one-shot channel. No `caller` is
    // sent — the desktop asks on the user's behalf and gets the operator
    // view (see gateway/src/main.ts).
    // ------------------------------------------------------------------

    /// Send one job command and block for its reply.
    fn job_request(
        &self,
        app: &AppHandle,
        mut value: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.ensure_spawned(app)?;
        let request_id = {
            let mut inner = self.lock();
            inner.job_seq += 1;
            format!("desk-{}", inner.job_seq)
        };
        value["requestId"] = serde_json::json!(request_id);

        let (tx, rx) = mpsc::channel();
        self.lock().job_waiters.insert(request_id.clone(), tx);
        if let Err(e) = self.send(value.to_string()) {
            self.lock().job_waiters.remove(&request_id);
            return Err(e);
        }
        let outcome = rx
            .recv_timeout(timeout)
            .unwrap_or_else(|_| Err("网关没有响应任务请求".to_string()));
        // Always drop the slot: a timed-out request must not leak a waiter.
        self.lock().job_waiters.remove(&request_id);
        outcome
    }

    /// Start a background job; returns its id.
    pub fn job_start(&self, app: &AppHandle, job: serde_json::Value) -> Result<String, String> {
        let reply = self.job_request(
            app,
            serde_json::json!({ "cmd": "job_start", "job": job }),
            Duration::from_secs(10),
        )?;
        self.cache_jobs_from(&reply);
        reply
            .get("id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| "网关没有返回任务 id".to_string())
    }

    /// Full job list, refreshed from the gateway.
    pub fn job_list(&self, app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
        let reply = self.job_request(
            app,
            serde_json::json!({ "cmd": "job_status" }),
            Duration::from_secs(10),
        )?;
        let jobs = reply
            .get("jobs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        self.lock().jobs = jobs.clone();
        Ok(jobs)
    }

    /// Consuming read of a job's new output.
    pub fn job_logs(&self, app: &AppHandle, id: &str) -> Result<String, String> {
        let reply = self.job_request(
            app,
            serde_json::json!({ "cmd": "job_logs", "id": id }),
            Duration::from_secs(10),
        )?;
        self.cache_jobs_from(&reply);
        Ok(reply
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// Stop a job; "requested" or "already-finished".
    pub fn job_stop(&self, app: &AppHandle, id: &str, reason: Option<String>) -> Result<String, String> {
        let reply = self.job_request(
            app,
            serde_json::json!({ "cmd": "job_stop", "id": id, "reason": reason }),
            Duration::from_secs(10),
        )?;
        self.cache_jobs_from(&reply);
        Ok(reply
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("requested")
            .to_string())
    }

    /// Metrics extracted by the job's rules (newest `tail` entries).
    pub fn job_metrics(
        &self,
        app: &AppHandle,
        id: &str,
        tail: Option<u32>,
    ) -> Result<Vec<serde_json::Value>, String> {
        let reply = self.job_request(
            app,
            serde_json::json!({ "cmd": "job_metrics", "id": id, "tail": tail }),
            Duration::from_secs(10),
        )?;
        Ok(reply
            .get("metrics")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default())
    }

    /// Last known job list without touching the gateway (panel first paint).
    pub fn jobs_snapshot(&self) -> Vec<serde_json::Value> {
        self.lock().jobs.clone()
    }

    /// Merge the single-job snapshots a reply carries into the cache, so the
    /// panel stays current without a full refresh round-trip.
    fn cache_jobs_from(&self, reply: &serde_json::Value) {
        let Some(updates) = reply.get("jobs").and_then(|v| v.as_array()) else {
            return;
        };
        let mut inner = self.lock();
        for update in updates {
            let Some(id) = update.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            match inner.jobs.iter().position(|j| j.get("id").and_then(|v| v.as_str()) == Some(id)) {
                Some(i) => inner.jobs[i] = update.clone(),
                None => inner.jobs.push(update.clone()),
            }
        }
    }

    pub fn status(&self) -> GatewayStatusData {
        self.lock().status.clone()
    }

    fn update_status<F: FnOnce(&mut GatewayStatusData)>(&self, app: &AppHandle, f: F) {
        let snapshot = {
            let mut inner = self.lock();
            f(&mut inner.status);
            if inner.status.state == "connected" {
                inner.restart_attempts = 0;
            }
            inner.status.clone()
        };
        emit_status(app, &snapshot);
    }

    /// Stop the gateway for good (app exit): mark stopping so the exit
    /// watcher won't restart, then kill the child process.
    pub fn shutdown(&self) {
        let process = {
            let mut inner = self.lock();
            inner.stopping = true;
            inner.want_running = false;
            inner.process.take()
        };
        if let Some(p) = process {
            let mut child = p.child.lock().unwrap_or_else(|e| e.into_inner());
            crate::proc::kill_tree(&mut child);
        }
    }
}

fn emit_status(app: &AppHandle, status: &GatewayStatusData) {
    if let Err(e) = app.emit("gateway-status", status.clone()) {
        eprintln!("[kalo] emit gateway-status failed: {e}");
    }
}

fn handle_gateway_line(app: &AppHandle, line: &str) {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[kalo] non-JSON line from gateway ({e}): {line}");
            return;
        }
    };
    let Some(gateway) = app.try_state::<GatewayManager>() else {
        return;
    };
    let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match msg_type {
        "pair_qr" => {
            gateway.update_status(app, |s| {
                s.state = "pairing".into();
                s.qr_data_url = value.get("qrDataUrl").and_then(|v| v.as_str()).map(String::from);
                s.expires_in = value.get("expiresIn").and_then(|v| v.as_u64());
                s.message = None;
            });
        }
        "status" => {
            let state = value.get("state").and_then(|v| v.as_str()).unwrap_or("disconnected");
            gateway.update_status(app, |s| {
                s.state = state.to_string();
                if state != "pairing" {
                    s.qr_data_url = None;
                    s.expires_in = None;
                }
                if let Some(user) = value.get("user").and_then(|v| v.as_str()) {
                    s.user = Some(user.to_string());
                }
                if let Some(msg) = value.get("message").and_then(|v| v.as_str()) {
                    s.message = Some(msg.to_string());
                } else if state == "connected" {
                    s.message = None;
                }
            });
        }
        "error" => {
            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("未知错误");
            gateway.update_status(app, |s| {
                s.state = "error".into();
                s.message = Some(message.to_string());
                s.qr_data_url = None;
            });
        }
        "schedule_status" => {
            let tasks = value
                .get("tasks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            {
                let mut inner = gateway.lock();
                inner.schedules = tasks.clone();
            }
            if let Err(e) = app.emit("schedule-status", tasks) {
                eprintln!("[kalo] emit schedule-status failed: {e}");
            }
        }
        "schedule_error" => {
            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("任务操作失败");
            if let Err(e) = app.emit("schedule-error", message.to_string()) {
                eprintln!("[kalo] emit schedule-error failed: {e}");
            }
        }
        "feed_status" => {
            let feeds = value
                .get("feeds")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            gateway.lock().feeds = feeds.clone();
            if let Err(e) = app.emit("feed-status", feeds) {
                eprintln!("[kalo] emit feed-status failed: {e}");
            }
        }
        "feed_error" => {
            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("数据源操作失败");
            if let Err(e) = app.emit("feed-error", message.to_string()) {
                eprintln!("[kalo] emit feed-error failed: {e}");
            }
        }
        "job_reply" => {
            let Some(request_id) = value.get("requestId").and_then(|v| v.as_str()) else {
                return;
            };
            let waiter = gateway.lock().job_waiters.remove(request_id);
            let Some(tx) = waiter else {
                // Timed out already, or a reply to a request we never made.
                return;
            };
            let outcome = if value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                Ok(value.clone())
            } else {
                Err(value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("任务操作失败")
                    .to_string())
            };
            let _ = tx.send(outcome);
        }
        "job_event" => {
            // Unsolicited: something changed in the registry. The payload is
            // deliberately thin, so refresh off-thread and push the whole list
            // rather than trying to patch state from an event.
            if let Some(job) = value.get("job") {
                if let Err(e) = app.emit("job-done", job.clone()) {
                    eprintln!("[kalo] emit job-done failed: {e}");
                }
            }
            let app = app.clone();
            thread::spawn(move || {
                let Some(gateway) = app.try_state::<GatewayManager>() else {
                    return;
                };
                match gateway.job_list(&app) {
                    Ok(jobs) => {
                        if let Err(e) = app.emit("job-status", jobs) {
                            eprintln!("[kalo] emit job-status failed: {e}");
                        }
                    }
                    Err(e) => eprintln!("[kalo] job refresh failed: {e}"),
                }
            });
        }
        "session_request" => handle_session_request(app, &value),
        _ => {}
    }
}

// ============================================================================
// Scheduler agent tasks: headless pi sessions (P0-A, roadmap §4.2)
// ============================================================================

/// The gateway asked us to run an agent task: spawn a headless pi session
/// in `cwd`, wait for the engine's RPC loop (it silently drops commands
/// sent before that), then blind-send the prompt. Progress flows back to
/// the gateway through the normal event forwarding chain.
fn handle_session_request(app: &AppHandle, value: &serde_json::Value) {
    let task_id = value.get("taskId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cwd = value.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let prompt = value.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model = value.get("model").and_then(|v| v.as_str()).map(String::from);

    let gateway = app.state::<GatewayManager>();
    let report_failure = |error: String| {
        let line = serde_json::json!({
            "cmd": "session_start_failed",
            "taskId": task_id,
            "error": error,
        });
        let _ = gateway.send(line.to_string());
    };

    if task_id.is_empty() || cwd.is_empty() || prompt.is_empty() {
        report_failure("session_request 缺少 taskId/cwd/prompt".into());
        return;
    }

    let session_id = crate::gen_session_id();
    let mut process = match PiProcess::spawn(&session_id, &cwd, app.clone()) {
        Ok(p) => p,
        Err(e) => {
            report_failure(e);
            return;
        }
    };
    process.source = "gateway".to_string();
    {
        let sessions = app.state::<SessionManager>();
        let Ok(mut map) = sessions.sessions.lock() else {
            report_failure("session manager lock poisoned".into());
            return;
        };
        map.insert(session_id.clone(), process);
    }
    let line = serde_json::json!({
        "cmd": "session_started",
        "taskId": task_id,
        "sessionId": session_id,
    });
    let _ = gateway.send(line.to_string());

    // Probe readiness, then deliver the prompt. Runs on its own thread so
    // the gateway stdout reader is never blocked.
    let app = app.clone();
    thread::spawn(move || {
        if !wait_for_engine(&app, &session_id, Duration::from_secs(20)) {
            eprintln!("[kalo] scheduled session {session_id}: engine never became ready");
            return;
        }
        let sessions = app.state::<SessionManager>();
        let Ok(map) = sessions.sessions.lock() else {
            return;
        };
        let Some(process) = map.get(&session_id) else {
            return;
        };
        if let Some(model) = model.as_deref() {
            if let Some((provider, model_id)) = model.split_once('/') {
                let cmd = serde_json::json!({
                    "id": format!("sched-model-{session_id}"),
                    "type": "set_model",
                    "provider": provider,
                    "modelId": model_id,
                });
                let _ = process.send(cmd.to_string());
            }
        }
        let cmd = serde_json::json!({
            "id": format!("sched-prompt-{session_id}"),
            "type": "prompt",
            "message": prompt,
        });
        let _ = process.send(cmd.to_string());
    });
}

/// Retry `get_state` until the engine answers (exponential backoff +
/// jitter, mirroring the frontend's waitForEngine in chat-store.ts).
fn wait_for_engine(app: &AppHandle, session_id: &str, budget: Duration) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

    let start = std::time::Instant::now();
    let mut delay = Duration::from_millis(250);
    while start.elapsed() < budget {
        let probe_id = format!("sched-probe-{}", PROBE_SEQ.fetch_add(1, Ordering::Relaxed));
        let sessions = app.state::<SessionManager>();
        let Some(rx) = sessions.register_probe(probe_id.clone()) else {
            return false;
        };
        {
            let Ok(map) = sessions.sessions.lock() else {
                sessions.unregister_probe(&probe_id);
                return false;
            };
            let Some(process) = map.get(session_id) else {
                sessions.unregister_probe(&probe_id);
                return false;
            };
            let cmd = serde_json::json!({ "id": probe_id, "type": "get_state" });
            if process.send(cmd.to_string()).is_err() {
                sessions.unregister_probe(&probe_id);
                return false;
            }
        }
        if rx.recv_timeout(Duration::from_secs(2)).is_ok() {
            return true;
        }
        sessions.unregister_probe(&probe_id);
        thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(2));
    }
    false
}

/// Exit-watcher callback: cleanup, status update and crash restart policy.
fn on_gateway_exit(app: &AppHandle, code: Option<i32>) {
    let Some(gateway) = app.try_state::<GatewayManager>() else {
        return;
    };
    let (should_restart, attempts) = {
        let mut inner = gateway.lock();
        inner.process = None;
        let deliberate = inner.stopping;
        inner.stopping = false;
        let restart = inner.want_running && !deliberate;
        if restart {
            inner.restart_attempts += 1;
        } else {
            inner.want_running = false;
            if deliberate {
                inner.status = GatewayStatusData::new("disconnected");
            }
        }
        (restart, inner.restart_attempts)
    };

    if should_restart && attempts <= MAX_RESTARTS {
        let delay = Duration::from_millis(500u64.saturating_mul(1 << attempts.min(6)));
        eprintln!(
            "[kalo] gateway exited (code {code:?}), restarting in {delay:?} (attempt {attempts})"
        );
        // Clone the AppHandle ('static) and re-acquire the manager inside
        // the thread — State<'_, _> borrows cannot cross the spawn boundary.
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(delay);
            let gateway = app.state::<GatewayManager>();
            if let Err(e) = gateway.ensure_spawned(&app) {
                eprintln!("[kalo] gateway restart failed: {e}");
                gateway.update_status(&app, |s| {
                    s.state = "error".into();
                    s.message = Some(format!("网关重启失败：{e}"));
                });
            }
        });
    } else if should_restart {
        eprintln!("[kalo] gateway exited (code {code:?}); restart budget exhausted");
        gateway.update_status(app, |s| {
            s.state = "error".into();
            s.message = Some("网关多次异常退出，已停止自动重启".into());
        });
    } else {
        emit_status(app, &gateway.status());
    }
}

/// Resolve the gateway executable, mirroring `resolve_pi_path()`:
/// 1. `KALO_GATEWAY_PATH` env var,
/// 2. `binaries/kalo-gateway-<triple>.exe` next to the app exe,
/// 3. `src-tauri/binaries/` dev layout.
fn resolve_gateway_path() -> Result<PathBuf, String> {
    if let Ok(override_path) = std::env::var("KALO_GATEWAY_PATH") {
        let p = PathBuf::from(override_path);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("KALO_GATEWAY_PATH does not point to a file: {}", p.display()));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("binaries").join(SIDECAR);
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(SIDECAR);
    if p.is_file() {
        return Ok(p);
    }

    Err(format!(
        "gateway binary not found; set KALO_GATEWAY_PATH or place {SIDECAR} under a binaries/ directory"
    ))
}

// ============================================================================
// Free functions used by session.rs (zero-cost when no gateway is running)
// ============================================================================

/// Forward one parsed engine stdout line to the gateway, if it is running.
pub fn forward_engine_event(app: &AppHandle, session_id: &str, cwd: &str, payload: &serde_json::Value) {
    if let Some(gateway) = app.try_state::<GatewayManager>() {
        gateway.forward_event(session_id, cwd, payload);
    }
}

/// Forward an engine process exit to the gateway, if it is running.
pub fn forward_engine_exit(app: &AppHandle, session_id: &str, code: Option<i32>) {
    if let Some(gateway) = app.try_state::<GatewayManager>() {
        gateway.forward_exit(session_id, code);
    }
}

/// Auto-start on app launch.
///
/// The gateway is no longer just the Feishu bridge: it also owns the job
/// runtime, which pi sessions reach over the loopback endpoint. Gating the
/// start on Feishu credentials therefore left every job tool dead on a
/// machine that never paired. It now always starts; with no credentials it
/// simply reports "disconnected" and serves jobs.
pub fn autostart(app: &AppHandle) {
    if let Err(e) = app.state::<GatewayManager>().ensure_spawned(app) {
        eprintln!("[kalo] gateway autostart skipped: {e}");
    }
}
