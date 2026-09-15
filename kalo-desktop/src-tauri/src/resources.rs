//! Where the resources bundled into the installer live at runtime.
//!
//! `tauri.conf.json`'s `bundle.resources` (the staged sidecars, `theme/`,
//! `node_modules/`, `internal-skills/`, ...) end up in a different place on
//! each platform:
//!
//! | platform         | resource root                     |
//! | ---------------- | --------------------------------- |
//! | macOS (`.app`)   | `Kalo.app/Contents/Resources/`    |
//! | Windows (nsis)   | next to the executable            |
//!
//! Tauri knows the layout, so we ask it (`path().resource_dir()`) rather than
//! computing `../Resources` ourselves — a second copy of that assumption is
//! exactly the kind of thing that drifts, and the symptom would again be a
//! sidecar that cannot be found.
//!
//! The handle only exists once the app is built, while the lookups that need
//! this (`sidecar::resolve`, `internal_skills::source_dir`) run from call
//! sites with no `AppHandle` in reach. Hence the one-shot global: `init()` in
//! `setup()`, read anywhere after.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Record the resource root. Call once, as the first thing in `setup()` —
/// `gateway::autostart()` resolves a sidecar and runs right after.
///
/// A failure here is not fatal: the lookups fall back to the executable's own
/// directory, which is the correct answer on Windows anyway.
pub fn init(app: &AppHandle) {
    match app.path().resource_dir() {
        Ok(dir) => {
            let _ = RESOURCE_DIR.set(dir);
        }
        Err(e) => eprintln!("[resources] cannot resolve resource dir: {e}"),
    }
}

/// The resource root, or `None` before [`init`] (unit tests, early startup).
pub fn dir() -> Option<&'static Path> {
    RESOURCE_DIR.get().map(PathBuf::as_path)
}
