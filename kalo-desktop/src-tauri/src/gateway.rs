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
//! Every state change is cached here and pushed to the frontend as the
//! `gateway-status` Tauri event. Engine events are forwarded best-effort:
//! with no gateway running the forward is a cheap mutex check and a drop.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::session::NdjsonFramer;

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
}

impl Default for GatewayInner {
    fn default() -> Self {
        Self {
            process: None,
            status: GatewayStatusData::new("disconnected"),
            restart_attempts: 0,
            want_running: false,
            stopping: false,
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
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

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
                let code = child_arc
                    .lock()
                    .ok()
                    .and_then(|mut c| c.wait().ok())
                    .and_then(|s| s.code());
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

    /// Unbind: the gateway deletes credentials and exits; the exit watcher
    /// finalizes the "disconnected" state without restarting.
    pub fn unbind(&self) -> Result<(), String> {
        {
            let mut inner = self.lock();
            inner.stopping = true;
        }
        let result = self.send_cmd("unbind");
        if result.is_err() {
            // Gateway already gone — fall back to a local reset.
            let mut inner = self.lock();
            inner.stopping = false;
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
            if let Ok(mut child) = p.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
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
        _ => {}
    }
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

/// Whether Feishu credentials exist (gates auto-start on app launch).
pub fn credentials_exist() -> bool {
    agent_dir()
        .map(|d| d.join("feishu.json").is_file())
        .unwrap_or(false)
}

fn agent_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("agent"))
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

/// Best-effort auto-start on app launch when credentials already exist.
pub fn autostart(app: &AppHandle) {
    if !credentials_exist() {
        return;
    }
    if let Err(e) = app.state::<GatewayManager>().ensure_spawned(app) {
        eprintln!("[kalo] gateway autostart skipped: {e}");
    }
}
