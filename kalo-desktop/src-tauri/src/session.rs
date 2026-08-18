//! Pi engine subprocess management.
//!
//! Each `PiProcess` drives one `pi --mode rpc` child process. Communication
//! is NDJSON over stdin/stdout: one JSON object per line, LF-terminated.
//! Stdout lines are emitted to the frontend as `pi-event:{session_id}`,
//! stderr lines as `pi-stderr:{session_id}`, and process exit as
//! `pi-exit:{session_id}` with payload `{"code": Option<i32>}`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use tauri::{AppHandle, Emitter};

/// Registry of live pi subprocesses, keyed by session id.
#[derive(Default)]
pub struct SessionManager {
    pub sessions: Mutex<HashMap<String, PiProcess>>,
    /// Pending engine-readiness probes: RPC request id → notifier. The
    /// engine silently drops commands received before its dispatch loop is
    /// up, so headless sessions (scheduler) probe with `get_state` first.
    probe_waiters: Mutex<HashMap<String, mpsc::Sender<()>>>,
}

impl SessionManager {
    /// Register a probe waiter for an RPC request id; the receiver fires
    /// once a `type:"response"` line with that id arrives on stdout.
    pub fn register_probe(&self, id: String) -> Option<mpsc::Receiver<()>> {
        let (tx, rx) = mpsc::channel();
        match self.probe_waiters.lock() {
            Ok(mut map) => {
                map.insert(id, tx);
                Some(rx)
            }
            Err(_) => None,
        }
    }

    pub fn unregister_probe(&self, id: &str) {
        if let Ok(mut map) = self.probe_waiters.lock() {
            map.remove(id);
        }
    }
}

/// Notify a probe waiter if this stdout line is its correlated response.
/// Cheap fast path: no waiters registered → no parsing at all.
fn notify_probe(app: &AppHandle, line: &str) {
    use tauri::Manager;
    let Some(sessions) = app.try_state::<SessionManager>() else {
        return;
    };
    {
        let Ok(map) = sessions.probe_waiters.lock() else {
            return;
        };
        if map.is_empty() {
            return;
        }
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    if value.get("type").and_then(|v| v.as_str()) != Some("response") {
        return;
    }
    let Some(id) = value.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    if let Ok(mut map) = sessions.probe_waiters.lock() {
        if let Some(tx) = map.remove(id) {
            let _ = tx.send(());
        }
    };
}

/// Incremental NDJSON framer.
///
/// Buffers raw bytes across reads and yields complete lines split on `\n`
/// only. Trailing `\r` is stripped, empty lines are skipped, and invalid
/// UTF-8 is replaced rather than fatal. Multibyte characters split across
/// chunks are safe because decoding only happens once a full line is
/// delimited.
pub struct NdjsonFramer {
    buf: Vec<u8>,
}

impl NdjsonFramer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Feed a chunk of bytes; returns any complete lines it contained.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }

    /// Flush a trailing line that had no newline (call at EOF).
    pub fn finish(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let mut line = std::mem::take(&mut self.buf);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(&line).into_owned())
    }
}

/// Resolve the pi executable:
/// 1. `KALO_PI_PATH` env var (explicit override),
/// 2. `binaries/pi-<target-triple>.exe` next to the app exe (Tauri sidecar),
/// 3. `src-tauri/binaries/pi-<target-triple>.exe` (dev layout).
/// Public alias: the engine binary path, for callers that need to hand it to
/// a child process (a tool that spawns its own agent, for instance).
pub fn engine_binary_path() -> Result<PathBuf, String> {
    resolve_pi_path()
}

fn resolve_pi_path() -> Result<PathBuf, String> {
    const SIDECAR: &str = "pi-x86_64-pc-windows-msvc.exe";

    if let Ok(override_path) = std::env::var("KALO_PI_PATH") {
        let p = PathBuf::from(override_path);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("KALO_PI_PATH does not point to a file: {}", p.display()));
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
        "pi binary not found; set KALO_PI_PATH or place {} under a binaries/ directory",
        SIDECAR
    ))
}

/// One running `pi --mode rpc` subprocess.
pub struct PiProcess {
    child: Arc<Mutex<Child>>,
    stdin_tx: mpsc::Sender<String>,
    /// Working directory the engine was spawned in (job center display).
    pub cwd: String,
    /// Who spawned this session: "desktop" (user UI) or "gateway" (scheduled task).
    pub source: String,
    /// ISO-ish start timestamp (job center display).
    pub started_at: String,
}

impl PiProcess {
    /// Spawn pi in `cwd` and wire up the IO threads that emit Tauri events.
    pub fn spawn(session_id: &str, cwd: &str, app: AppHandle) -> Result<Self, String> {
        let pi_path = resolve_pi_path()?;

        let mut cmd = Command::new(&pi_path);
        cmd.args(["--mode", "rpc"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // Prevent a console window from flashing for the child process.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", pi_path.display()))?;

        let mut stdin = child.stdin.take().ok_or("pi stdin was not piped")?;
        let mut stdout = child.stdout.take().ok_or("pi stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("pi stderr was not piped")?;

        let child = Arc::new(Mutex::new(child));

        // stdin writer: serialized NDJSON commands, one per line.
        let (stdin_tx, stdin_rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in stdin_rx {
                let mut bytes = line.into_bytes();
                bytes.push(b'\n');
                let result = stdin
                    .write_all(&bytes)
                    .and_then(|_| stdin.flush());
                if let Err(e) = result {
                    eprintln!("[kalo] pi stdin write failed, stopping writer: {e}");
                    break;
                }
            }
        });

        // stdout reader: frame NDJSON and emit each object to the frontend,
        // and forward the same line to the IM gateway when one is running.
        {
            let event_name = format!("pi-event:{session_id}");
            let session_id = session_id.to_string();
            let cwd = cwd.to_string();
            let app = app.clone();
            thread::spawn(move || {
                let mut framer = NdjsonFramer::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match stdout.read(&mut chunk) {
                        Ok(0) => break, // EOF: child closed stdout
                        Ok(n) => {
                            for line in framer.push(&chunk[..n]) {
                                notify_probe(&app, &line);
                                emit_json_line(&app, &event_name, &line);
                                forward_to_gateway(&app, &session_id, &cwd, &line);
                            }
                        }
                        Err(e) => {
                            eprintln!("[kalo] pi stdout read failed: {e}");
                            break;
                        }
                    }
                }
                if let Some(line) = framer.finish() {
                    notify_probe(&app, &line);
                    emit_json_line(&app, &event_name, &line);
                    forward_to_gateway(&app, &session_id, &cwd, &line);
                }
            });
        }

        // stderr reader: forward lines as plain strings for diagnostics.
        {
            let event_name = format!("pi-stderr:{session_id}");
            let app = app.clone();
            let mut stderr = stderr;
            thread::spawn(move || {
                let mut framer = NdjsonFramer::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match stderr.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            for line in framer.push(&chunk[..n]) {
                                if let Err(e) = app.emit(&event_name, line) {
                                    eprintln!("[kalo] emit {event_name} failed: {e}");
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[kalo] pi stderr read failed: {e}");
                            break;
                        }
                    }
                }
                if let Some(line) = framer.finish() {
                    if let Err(e) = app.emit(&event_name, line) {
                        eprintln!("[kalo] emit {event_name} failed: {e}");
                    }
                }
            });
        }

        // exit watcher: report the exit code once the child terminates.
        {
            let event_name = format!("pi-exit:{session_id}");
            let session_id = session_id.to_string();
            let child = Arc::clone(&child);
            thread::spawn(move || {
                // Polls instead of blocking in `wait`, so `kill` can take the
                // lock while the engine is still alive. See `proc.rs`.
                let code = crate::proc::wait_released(&child);
                if let Err(e) = app.emit(&event_name, serde_json::json!({ "code": code })) {
                    eprintln!("[kalo] emit {event_name} failed: {e}");
                }
                crate::gateway::forward_engine_exit(&app, &session_id, code);
            });
        }

        Ok(Self {
            child,
            stdin_tx,
            cwd: cwd.to_string(),
            source: "desktop".to_string(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default(),
        })
    }

    /// Queue one NDJSON line for the child's stdin.
    pub fn send(&self, line: String) -> Result<(), String> {
        self.stdin_tx
            .send(line)
            .map_err(|e| format!("pi stdin channel is closed: {e}"))
    }

    /// Terminate the child process and everything it spawned. Errors are
    /// logged, never panicked.
    pub fn kill(&mut self) {
        // Recover from poisoning: a watcher thread that panicked is exactly
        // when the engine still needs killing.
        let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
        crate::proc::kill_tree(&mut child);
    }
}

/// Parse one stdout line as JSON and emit it; non-JSON lines are logged.
fn emit_json_line(app: &AppHandle, event_name: &str, line: &str) {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) => {
            if let Err(e) = app.emit(event_name, value) {
                eprintln!("[kalo] emit {event_name} failed: {e}");
            }
        }
        Err(e) => eprintln!("[kalo] non-JSON line from pi stdout ({e}): {line}"),
    }
}

/// Forward one engine stdout line to the IM gateway sidecar. Parsing is
/// skipped entirely when no gateway is running (the common case).
fn forward_to_gateway(app: &AppHandle, session_id: &str, cwd: &str, line: &str) {
    use tauri::Manager;
    if app.try_state::<crate::gateway::GatewayManager>().is_none() {
        return;
    }
    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(line) {
        crate::gateway::forward_engine_event(app, session_id, cwd, &payload);
    }
}

#[cfg(test)]
mod tests {
    use super::NdjsonFramer;

    #[test]
    fn multiple_lines_in_one_chunk() {
        let mut f = NdjsonFramer::new();
        let out = f.push(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(out, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn line_split_across_chunks() {
        let mut f = NdjsonFramer::new();
        assert!(f.push(b"{\"msg\":\"he").is_empty());
        assert!(f.push(b"llo\"}").is_empty());
        assert_eq!(f.push(b"\n"), vec!["{\"msg\":\"hello\"}"]);
    }

    #[test]
    fn multibyte_char_split_across_chunks() {
        let mut f = NdjsonFramer::new();
        let full = "{\"text\":\"你好\"}\n".as_bytes();
        // Split in the middle of the first multibyte character.
        let split = full
            .iter()
            .position(|&b| b == 0xE4)
            .expect("test data contains the lead byte")
            + 1;
        assert!(f.push(&full[..split]).is_empty());
        let out = f.push(&full[split..]);
        assert_eq!(out, vec!["{\"text\":\"你好\"}"]);
    }

    #[test]
    fn crlf_line_endings_are_tolerated() {
        let mut f = NdjsonFramer::new();
        assert_eq!(f.push(b"{\"a\":1}\r\n{\"b\":2}\r\n"), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn empty_lines_are_skipped() {
        let mut f = NdjsonFramer::new();
        assert_eq!(f.push(b"\n\r\n{\"a\":1}\n\n"), vec!["{\"a\":1}"]);
    }

    #[test]
    fn invalid_utf8_is_replaced_not_fatal() {
        let mut f = NdjsonFramer::new();
        let out = f.push(b"{\"bad\":\"\xff\xfe\"}\n{\"ok\":1}\n");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains('\u{FFFD}'));
        assert_eq!(out[1], "{\"ok\":1}");
    }

    #[test]
    fn finish_flushes_trailing_line_without_newline() {
        let mut f = NdjsonFramer::new();
        assert!(f.push(b"{\"a\":1}").is_empty());
        assert_eq!(f.finish(), Some("{\"a\":1}".to_string()));
        assert_eq!(f.finish(), None);
    }
}
