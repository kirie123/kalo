//! Keep the UI schedulable when the machine is loaded by something else.
//!
//! A user running a training job (or any other all-core workload) alongside
//! Kalo can hit a window that renders its last frame fine but swallows input:
//! the process was pushed into the background scheduling class. Windows
//! applies EcoQoS (Efficiency Mode) to non-foreground windows — pinning them
//! to E-cores and capping their clock — and on a hybrid CPU whose E-cores are
//! busy with the user's job, the WebView2 renderer can be starved for seconds
//! at a time. The user sees "the input box looks normal but typing does
//! nothing", which is exactly what a stalled renderer looks like.
//!
//! So: raise this process and its WebView2 children to `ABOVE_NORMAL` and turn
//! execution-speed throttling off, and re-apply as WebView2 lazily creates
//! renderer/GPU processes.
//!
//! Deliberately NOT touched: the pi engine sidecar and the gateway. They are
//! peers of the user's workload — the training command they are running IS the
//! user's job — so raising them would steal CPU from the thing the user is
//! waiting on. Do not "unify" this later.
//!
//! Design: doc/2026-10-01-高负载下界面响应与输入可见性.md §2.

/// Start the (best-effort) UI priority watchdog. No-op off Windows.
pub fn keep_ui_responsive() {
    #[cfg(windows)]
    win::spawn_watchdog();
}

#[cfg(windows)]
mod win {
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::thread;
    use std::time::Duration;

    /// ABOVE_NORMAL_PRIORITY_CLASS (winbase.h). Above normal, not HIGH: the UI
    /// only needs to not lose the race, it must not outrank the user's job.
    const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;
    /// PROCESS_SET_INFORMATION (winnt.h).
    const PROCESS_SET_INFORMATION: u32 = 0x0200;
    /// TH32CS_SNAPPROCESS (tlhelp32.h).
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    /// PROCESS_INFORMATION_CLASS::ProcessPowerThrottling (processthreadsapi.h).
    const PROCESS_POWER_THROTTLING: i32 = 4;
    /// PROCESS_POWER_THROTTLING_CURRENT_VERSION / _EXECUTION_SPEED.
    const POWER_THROTTLING_VERSION: u32 = 1;
    const POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;
    /// MAX_PATH.
    const MAX_PATH_W: usize = 260;
    /// WebView2 processes are the only children we care about.
    const WEBVIEW_EXE: &str = "msedgewebview2.exe";
    /// WebView2 spawns renderer/GPU/utility processes lazily and rebuilds them
    /// after a crash, so a one-shot pass at startup is not enough.
    const RESCAN: Duration = Duration::from_secs(5);
    /// The first cycles run much faster: the initial renderer/GPU processes are
    /// created within the first second of the window existing, right after the
    /// one pass this module gets at setup time.
    const STARTUP_RESCAN: Duration = Duration::from_millis(500);
    const STARTUP_CYCLES: u32 = 10;
    /// Give up growing the "already handled" set past this; a fresh set only
    /// costs a few redundant calls per cycle.
    const MAX_TRACKED: usize = 1024;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; MAX_PATH_W],
    }

    #[repr(C)]
    struct PowerThrottlingState {
        version: u32,
        control_mask: u32,
        state_mask: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn SetPriorityClass(process: *mut c_void, class: u32) -> i32;
        fn SetProcessInformation(
            process: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    }

    /// `(pid, parent pid, exe name)` for every process we can see.
    fn snapshot() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 {
                return out;
            }
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry) != 0;
            while ok {
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(MAX_PATH_W);
                let name = String::from_utf16_lossy(&entry.sz_exe_file[..len]);
                out.push((entry.th32_process_id, entry.th32_parent_process_id, name));
                ok = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
        }
        out
    }

    /// Every descendant of `root` — WebView2's renderer/GPU processes are
    /// grandchildren (children of the browser process), not direct children.
    /// Pure so it can be tested without touching the process table.
    fn descendants(root: u32, procs: &[(u32, u32, String)]) -> Vec<u32> {
        let mut want = vec![root];
        let mut out: Vec<u32> = Vec::new();
        // Process count is small; the repeated scan keeps this branch-free.
        loop {
            let mut grew = false;
            for (pid, ppid, _) in procs {
                if want.contains(ppid) && !want.contains(pid) {
                    want.push(*pid);
                    out.push(*pid);
                    grew = true;
                }
            }
            if !grew {
                return out;
            }
        }
    }

    /// WebView2 processes that hang off this app. Pure.
    pub(super) fn webview_children(root: u32, procs: &[(u32, u32, String)]) -> Vec<u32> {
        descendants(root, procs)
            .into_iter()
            .filter(|pid| {
                procs
                    .iter()
                    .any(|(p, _, name)| p == pid && name.eq_ignore_ascii_case(WEBVIEW_EXE))
            })
            .collect()
    }

    /// `ABOVE_NORMAL` + execution-speed throttling off. Best-effort.
    fn apply(process: *mut c_void) {
        unsafe {
            if SetPriorityClass(process, ABOVE_NORMAL_PRIORITY_CLASS) == 0 {
                eprintln!("[priority] SetPriorityClass failed");
            }
            let mut state = PowerThrottlingState {
                version: POWER_THROTTLING_VERSION,
                // Only ask about the execution-speed lever; leave timer
                // resolution alone (it is a media-timing knob, not ours).
                control_mask: POWER_THROTTLING_EXECUTION_SPEED,
                // 0 = do not throttle. This is the actual EcoQoS opt-out.
                state_mask: 0,
            };
            let ok = SetProcessInformation(
                process,
                PROCESS_POWER_THROTTLING,
                &mut state as *mut PowerThrottlingState as *mut c_void,
                std::mem::size_of::<PowerThrottlingState>() as u32,
            );
            if ok == 0 {
                // Windows 8+ only, and some downlevel builds reject the class;
                // the priority call above is already the bigger win.
                eprintln!("[priority] SetProcessInformation(power throttling) failed");
            }
        }
    }

    /// Apply to ourselves and every WebView2 descendant. Returns how many
    /// processes were touched (so the caller can skip a redundant log).
    fn apply_once(handled: &mut HashSet<u32>) -> usize {
        let mut touched = 0;
        let me = std::process::id();
        // Ourselves: OpenProcess would need rights we may not have, and the
        // pseudo-handle is always valid for the current process.
        if handled.insert(me) {
            apply(unsafe { GetCurrentProcess() });
            touched += 1;
        }
        for pid in webview_children(me, &snapshot()) {
            if !handled.insert(pid) {
                continue;
            }
            let handle = unsafe { OpenProcess(PROCESS_SET_INFORMATION, 0, pid) };
            if handle.is_null() {
                // Happens for the browser process before we get rights;
                // dropping the pid from the set means we retry next cycle.
                handled.remove(&pid);
                continue;
            }
            apply(handle);
            unsafe { CloseHandle(handle) };
            touched += 1;
        }
        touched
    }

    /// Background watchdog: WebView2 creates its renderer/GPU processes after
    /// startup, so the first pass alone would miss them.
    pub(super) fn spawn_watchdog() {
        thread::spawn(move || {
            let mut handled: HashSet<u32> = HashSet::new();
            let mut cycles: u32 = 0;
            loop {
                if handled.len() > MAX_TRACKED {
                    handled.clear();
                }
                let touched = apply_once(&mut handled);
                if touched > 0 {
                    eprintln!("[priority] raised {touched} UI process(es) to above-normal");
                }
                cycles += 1;
                thread::sleep(if cycles <= STARTUP_CYCLES { STARTUP_RESCAN } else { RESCAN });
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::{descendants, webview_children};

        fn procs() -> Vec<(u32, u32, String)> {
            vec![
                (100, 1, "kalo.exe".into()),
                (200, 100, "msedgewebview2.exe".into()),
                (300, 200, "msedgewebview2.exe".into()),
                (400, 200, "msedgewebview2.exe".into()),
                (500, 100, "pi-x86_64-pc-windows-msvc.exe".into()),
                (600, 999, "msedgewebview2.exe".into()),
            ]
        }

        #[test]
        fn descendants_walk_the_whole_tree() {
            let mut got = descendants(100, &procs());
            got.sort_unstable();
            assert_eq!(got, vec![200, 300, 400, 500]);
        }

        #[test]
        fn only_webview_children_are_touched() {
            // A WebView2 process owned by another app (600) must not be
            // touched, and neither must the engine sidecar (500).
            let mut got = webview_children(100, &procs());
            got.sort_unstable();
            assert_eq!(got, vec![200, 300, 400]);
        }

        #[test]
        fn unknown_root_yields_nothing() {
            assert!(webview_children(4242, &procs()).is_empty());
        }
    }
}