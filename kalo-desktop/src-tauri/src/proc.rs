//! Child-process helpers shared by the engine and the gateway sidecar.
//!
//! Both of them own a `Arc<Mutex<Child>>` that two parties need: a watcher
//! thread that wants the exit code, and whoever kills the process on shutdown.
//! `Child::wait` blocks until the process dies, so a watcher that calls it
//! while holding the mutex holds that mutex for the child's entire lifetime —
//! and the killer then waits forever for a lock that is only released once the
//! thing it is trying to kill has died. Closing the window would leave the
//! process alive with its children attached.

use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// How often the watcher checks whether the child has exited. Short enough to
/// report an exit promptly, long enough to be free.
const POLL: Duration = Duration::from_millis(100);

/// Keep a child from flashing a console window. No-op off Windows.
///
/// Every console subprocess we spawn wants this — the engine, the gateway, the
/// `taskkill` below, each `git` call — and a GUI app that pops a black box for
/// 80 ms looks broken. Returns `cmd` so it chains into a builder expression.
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, from winbase.h.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Block until the child exits, releasing the mutex between polls.
///
/// Use this instead of `child.lock().wait()`: it leaves the lock available so
/// [`kill_tree`] can actually take it.
pub fn wait_released(child: &Mutex<Child>) -> Option<i32> {
    loop {
        {
            let mut guard = match child.lock() {
                Ok(g) => g,
                Err(e) => {
                    eprintln!("[kalo] child lock poisoned while waiting: {e}");
                    return None;
                }
            };
            match guard.try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(e) => {
                    eprintln!("[kalo] try_wait failed: {e}");
                    return None;
                }
            }
        }
        thread::sleep(POLL);
    }
}

/// Kill the child *and everything it spawned*, then reap it.
///
/// A plain `Child::kill` only signals the immediate process. On Windows the
/// grandchildren (a tool call's shell, a spawned python) are not in any job
/// object of ours and survive their parent, which is how an old engine ends up
/// still holding `pi-*.exe` open long after the window is gone.
pub fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _ = no_window(&mut cmd).status();
    }
    // Still signal the child directly: taskkill may have missed it (already
    // gone, access denied), and on unix this is the whole of the kill.
    if let Err(e) = child.kill() {
        // Already exited is the common benign case.
        eprintln!("[kalo] kill failed (may already be dead): {e}");
    }
    // Reap, so the watcher's next poll does not race a zombie handle.
    let _ = child.try_wait();
}
