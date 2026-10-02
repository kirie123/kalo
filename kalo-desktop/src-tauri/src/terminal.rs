//! Embedded terminal sessions for the right-side workspace panel.
//!
//! One PTY-backed shell per terminal tab. The frontend owns the tab ids
//! (`crypto.randomUUID` / the watched bash `toolCallId`); this module only
//! maps id → live session and streams output back as `terminal-output:{id}`
//! batches, plus `terminal-exit:{id}` with `{"code": Option<i32>}`.
//!
//! Three threads per session, split by lifetime:
//!
//! - **reader** — blocking reads from the pty master, decoded incrementally so
//!   a multibyte character split across two reads does not turn into mojibake;
//!   hands text to the emitter over a channel. Ends on EOF.
//! - **emitter** — batches what the reader produced into ~frame-sized events.
//!   A noisy command (`yes`, `ls -R`) otherwise sends one IPC message per read
//!   chunk. Flushes whatever is pending before ending, so the exit notice never
//!   jumps ahead of the shell's last line.
//! - **exit watcher** — polls `try_wait` (released between polls; blocking in
//!   `wait` while holding the child mutex would deadlock `kill`, see proc.rs),
//!   waits for the emitter to drain, then retires the session and reports the
//!   exit code. Retiring is pointer-checked: a closed tab's id can be reused.
//!
//! Sessions die by `terminal_close` (tab closed), by the shell exiting on its
//! own, or by `kill_all` at app shutdown. Nothing here outlives the window.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::proc;

/// One output event per ~frame; the rest rides along in the next batch.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// But never sit on more than this much text, or a continuously busy command
/// would keep pushing the flush window forward forever.
const FLUSH_BYTES: usize = 64 * 1024;
/// Exit polling period — same cadence as proc.rs's watcher.
const EXIT_POLL: Duration = Duration::from_millis(100);

/// Registry of live terminals, keyed by frontend-generated id.
#[derive(Default)]
pub struct TerminalManager {
    /// `Arc` so the reader/exit threads — which outlive a command call — can
    /// retire their own session when the shell exits on its own.
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    code: Option<i32>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kill every shell. Called on app shutdown; without it the shells outlive
    /// the window as orphans (the same leak the engine processes had).
    pub fn kill_all(&self) {
        let Ok(mut map) = self.sessions.lock() else {
            return;
        };
        for (_, session) in map.drain() {
            kill_session(&session);
        }
    }
}

fn lookup(state: &TerminalManager, id: &str) -> Result<Arc<Session>, String> {
    state
        .sessions
        .lock()
        .ok()
        .and_then(|map| map.get(id).cloned())
        .ok_or_else(|| format!("终端会话不存在：{id}"))
}

/// Tab ids become event names (`terminal-output:{id}`), so keep them boring.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Shell for a new terminal tab. This is the whole platform split for shells:
/// Windows gets PowerShell (native ConPTY support), Unix gets the login shell
/// from `$SHELL`. A future shell picker only needs to change this function.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
    }
}

/// Start a shell in a new PTY. Spawns the reader/emitter/exit threads and
/// returns as soon as the session is registered.
#[tauri::command(async)]
pub fn terminal_open(
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("非法终端 id：{id}"));
    }
    let sessions = Arc::clone(&state.sessions);
    // Re-opening an id (rare) must not leak the old shell.
    if let Ok(mut map) = sessions.lock() {
        if let Some(old) = map.remove(&id) {
            kill_session(&old);
        }
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("创建终端失败：{e}"))?;

    let mut cmd = CommandBuilder::new(default_shell());
    // The pty answers terminal queries from this; ConPTY ignores it.
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.as_deref().filter(|d| Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 shell 失败：{e}"))?;
    // The child holds the slave side; our copy must go or EOF never reaches it.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("读取终端输出失败：{e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("打开终端输入失败：{e}"))?;

    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    if let Ok(mut map) = sessions.lock() {
        map.insert(id.clone(), Arc::clone(&session));
    }

    let output_done = spawn_output(&id, reader, &app);
    spawn_exit_watch(id, app, sessions, session, output_done);
    Ok(())
}

/// Keyboard input. Runs on the main thread on purpose: writes land in issue
/// order, so a fast typist cannot see keystrokes reordered.
#[tauri::command]
pub fn terminal_write(id: String, data: String, state: State<'_, TerminalManager>) -> Result<(), String> {
    let session = lookup(&state, &id)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "终端写入锁失效".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("终端写入失败：{e}"))
}

#[tauri::command]
pub fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    let session = lookup(&state, &id)?;
    let master = session
        .master
        .lock()
        .map_err(|_| "终端尺寸锁失效".to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("终端调整尺寸失败：{e}"))
}

/// Close a tab: kill the shell tree and forget the session.
#[tauri::command(async)]
pub fn terminal_close(id: String, state: State<'_, TerminalManager>) -> Result<(), String> {
    let removed = state.sessions.lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(session) = removed {
        kill_session(&session);
    }
    Ok(())
}

/// Kill a session's shell and its descendants. Windows needs the tree kill
/// (`taskkill /T`): killing only the shell leaves `npm`/`python` children
/// behind, the same leak proc.rs stops for engine processes.
fn kill_session(session: &Session) {
    let pid = session.child.lock().ok().and_then(|child| child.process_id());
    if let Some(pid) = pid {
        proc::kill_pid_tree(pid);
    }
    if let Ok(mut child) = session.child.lock() {
        if let Err(e) = child.kill() {
            // Already exited is the common benign case.
            eprintln!("[kalo] terminal kill failed (may already be dead): {e}");
        }
    }
}

/// Reader + emitter threads. Returns a receiver that fires when the emitter
/// drained everything the reader produced (used to order the exit notice).
fn spawn_output(id: &str, reader: Box<dyn Read + Send>, app: &AppHandle) -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel::<String>();
    let (done_tx, done_rx) = mpsc::channel::<()>();

    {
        let mut reader = reader;
        thread::spawn(move || {
            let mut decoder = Utf8StreamDecoder::default();
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = decoder.push(&buf[..n]);
                        if !text.is_empty() && tx.send(text).is_err() {
                            break;
                        }
                    }
                }
            }
            // Dropping tx disconnects the emitter; that is the EOF signal.
        });
    }

    let event_name = format!("terminal-output:{id}");
    let app = app.clone();
    thread::spawn(move || {
        let mut pending = String::new();
        let flush = |pending: &mut String| {
            if pending.is_empty() {
                return;
            }
            if let Err(e) = app.emit(&event_name, pending.as_str()) {
                eprintln!("[kalo] emit {event_name} failed: {e}");
            }
            pending.clear();
        };
        loop {
            match rx.recv_timeout(FLUSH_INTERVAL) {
                Ok(chunk) => {
                    pending.push_str(&chunk);
                    if pending.len() >= FLUSH_BYTES {
                        flush(&mut pending);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => flush(&mut pending),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&mut pending);
                    break;
                }
            }
        }
        let _ = done_tx.send(());
    });

    done_rx
}

/// Exit watcher: poll the child, let the output drain, then retire and report.
fn spawn_exit_watch(
    id: String,
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    session: Arc<Session>,
    output_done: mpsc::Receiver<()>,
) {
    thread::spawn(move || {
        let code = loop {
            // Poll instead of blocking in `wait` while holding the mutex:
            // `kill_session` needs that same mutex (proc.rs has the long story).
            let status = match session.child.lock() {
                Ok(mut child) => child.try_wait(),
                Err(_) => break None,
            };
            match status {
                Ok(Some(status)) => break Some(status.exit_code() as i32),
                Ok(None) => thread::sleep(EXIT_POLL),
                Err(e) => {
                    eprintln!("[kalo] terminal child wait failed: {e}");
                    break None;
                }
            }
        };

        // Final output must land before the exit notice, or the shell's last
        // line appears after "[exited]". Bounded: a reader that never EOFS
        // (protocol quirk) must not keep the notice hostage.
        let _ = output_done.recv_timeout(Duration::from_millis(500));

        // Retire only if the entry is still ours: closing the tab removes it
        // first, and the id may already belong to a new session.
        if let Ok(mut map) = sessions.lock() {
            if map
                .get(&id)
                .map(|s| Arc::ptr_eq(s, &session))
                .unwrap_or(false)
            {
                map.remove(&id);
            }
        }

        let name = format!("terminal-exit:{id}");
        if let Err(e) = app.emit(&name, TerminalExit { code }) {
            eprintln!("[kalo] emit {name} failed: {e}");
        }
    });
}

/// Incremental UTF-8 decoder for pty reads.
///
/// `read` returns arbitrary byte slices; a CJK character is three bytes and a
/// read boundary can land between them. Decoding each chunk on its own with
/// `from_utf8_lossy` would corrupt it into replacement characters. This keeps
/// the incomplete tail (≤ 3 bytes) until the rest arrives; genuinely invalid
/// bytes become U+FFFD like `from_utf8_lossy` would.
#[derive(Default)]
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut consumed = 0usize;
        loop {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(valid) => {
                    out.push_str(valid);
                    consumed = self.pending.len();
                    break;
                }
                Err(e) => {
                    let up_to = e.valid_up_to();
                    if up_to > 0 {
                        out.push_str(
                            std::str::from_utf8(&self.pending[consumed..consumed + up_to])
                                .unwrap_or_default(),
                        );
                    }
                    consumed += up_to;
                    match e.error_len() {
                        // Invalid sequence: emit the replacement char and skip it.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            consumed += len;
                        }
                        // Incomplete tail: keep it for the next push.
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_plain_ascii_in_one_pass() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.push(b"hello world"), "hello world");
    }

    #[test]
    fn keeps_a_multibyte_char_split_across_pushes() {
        let mut d = Utf8StreamDecoder::default();
        let bytes = "中文".as_bytes();
        // Split inside the first character (3-byte sequence).
        let (first, rest) = bytes.split_at(2);
        assert_eq!(d.push(first), "");
        assert_eq!(d.push(rest), "中文");
    }

    #[test]
    fn decodes_a_split_emoji() {
        let mut d = Utf8StreamDecoder::default();
        let bytes = "a🚀b".as_bytes();
        let (first, rest) = bytes.split_at(3); // 0..3 = "a" + first emoji byte
        assert_eq!(d.push(first), "a");
        assert_eq!(d.push(rest), "🚀b");
    }

    #[test]
    fn replaces_invalid_bytes_and_keeps_decoding() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn holds_an_incomplete_tail_until_it_completes() {
        let mut d = Utf8StreamDecoder::default();
        let bytes = "字".as_bytes();
        assert_eq!(d.push(&bytes[..1]), "");
        assert_eq!(d.push(&bytes[1..]), "字");
    }

    #[test]
    fn rejects_hostile_terminal_ids() {
        assert!(valid_id("term-1_abc"));
        assert!(!valid_id(""));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a:b"));
    }

    #[test]
    fn default_shell_is_not_empty() {
        assert!(!default_shell().is_empty());
    }
}