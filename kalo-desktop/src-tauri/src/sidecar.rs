//! Locating the sidecar executables this app ships: the pi engine and the IM
//! gateway.
//!
//! Both are staged by `scripts/build-engine.sh` / `scripts/build-gateway.sh`
//! under a `binaries/` directory, named `<stem>-<target-triple>` plus the
//! platform's executable suffix. The triple comes from `build.rs`, which
//! forwards cargo's `TARGET` — so the name this module asks for and the name
//! the build scripts wrote are derived from the same value and cannot drift.
//!
//! Embedding the triple in the file name is also what keeps a foreign-platform
//! binary from being picked up. The lookup used to hard-code
//! `pi-x86_64-pc-windows-msvc.exe`; on macOS that name still matched a real
//! file (the staged Windows engine), so resolution *succeeded* and the failure
//! only surfaced as an `Exec format error` at spawn time — which the UI could
//! report as nothing more useful than "engine unresponsive". A name carrying
//! the triple simply does not match, and the error below says so.

use std::path::{Path, PathBuf};

/// The target triple this binary was compiled for. Set by `build.rs`.
const TARGET_TRIPLE: &str = env!("KALO_TARGET_TRIPLE");

/// File name a sidecar with this stem has on this platform.
fn file_name(stem: &str) -> String {
    format!("{stem}-{TARGET_TRIPLE}{}", std::env::consts::EXE_SUFFIX)
}

/// Reject a candidate that exists but could never run, while we still know
/// which path we are talking about.
///
/// Staging normally preserves the exec bit, but an engine restored from an
/// archive or copied across a filesystem that drops permissions would spawn
/// with an errno the user cannot act on.
fn usable(p: &Path) -> Result<(), String> {
    if !p.is_file() {
        return Err(format!("not a file: {}", p.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = p
            .metadata()
            .map_err(|e| format!("cannot stat {}: {e}", p.display()))?
            .permissions()
            .mode();
        if mode & 0o111 == 0 {
            return Err(format!(
                "{} is not executable; run: chmod +x {}",
                p.display(),
                p.display()
            ));
        }
    }
    Ok(())
}

/// Resolve a sidecar executable:
/// 1. the `env_override` env var (explicit path to an external build),
/// 2. `binaries/<name>` next to the app executable (installed app),
/// 3. `src-tauri/binaries/<name>` (dev layout).
///
/// `stem` is the base name without triple or suffix, e.g. `"pi"`.
pub fn resolve(stem: &str, env_override: &str) -> Result<PathBuf, String> {
    let name = file_name(stem);

    if let Ok(over) = std::env::var(env_override) {
        let p = PathBuf::from(over);
        usable(&p).map_err(|e| format!("{env_override} does not point to a usable executable: {e}"))?;
        return Ok(p);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("binaries").join(&name));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&name),
    );

    for p in &candidates {
        if p.is_file() {
            usable(p)?;
            return Ok(p.clone());
        }
    }

    Err(not_found(&name, stem, env_override))
}

/// The "no sidecar for this platform" message, pointing at the script that
/// would produce one. Split out so it can be asserted without depending on
/// which binaries happen to be staged on the machine running the tests.
fn not_found(name: &str, stem: &str, env_override: &str) -> String {
    let script = match stem {
        "pi" => "scripts/build-engine.sh",
        "kalo-gateway" => "scripts/build-gateway.sh",
        _ => "the sidecar build scripts",
    };
    format!("{name} not found; build it with {script}, or point {env_override} at an existing one")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Temp dir removed on drop, so a failing assert cannot leak it.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "kalo-sidecar-test-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_exe(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn file_name_carries_triple_and_platform_suffix() {
        let name = file_name("pi");
        assert!(name.starts_with("pi-"), "{name}");
        assert!(name.contains(TARGET_TRIPLE), "{name}");
        assert!(name.ends_with(std::env::consts::EXE_SUFFIX), "{name}");
    }

    /// The regression this module exists for: a sidecar built for another
    /// platform must not answer to this platform's name.
    #[test]
    fn foreign_platform_binary_does_not_match() {
        let name = file_name("pi");
        assert_ne!(
            name, "pi-x86_64-pc-windows-msvc.exe",
            "a darwin/linux build must not resolve the Windows engine"
        );
    }

    #[test]
    fn env_override_wins() {
        let dir = TempDir::new("override");
        let exe = write_exe(&dir.0, "my-engine");
        // A per-test var name: distinct keys keep the process-global env from
        // racing the other tests.
        std::env::set_var("KALO_TEST_OVERRIDE_WINS", &exe);
        let got = resolve("pi", "KALO_TEST_OVERRIDE_WINS").unwrap();
        std::env::remove_var("KALO_TEST_OVERRIDE_WINS");
        assert_eq!(got, exe);
    }

    #[test]
    fn env_override_pointing_nowhere_names_the_variable() {
        std::env::set_var("KALO_TEST_OVERRIDE_MISSING", "/nonexistent/engine");
        let err = resolve("pi", "KALO_TEST_OVERRIDE_MISSING").unwrap_err();
        std::env::remove_var("KALO_TEST_OVERRIDE_MISSING");
        assert!(err.contains("KALO_TEST_OVERRIDE_MISSING"), "{err}");
    }

    #[test]
    fn missing_sidecar_error_points_at_the_build_script() {
        let engine = not_found(&file_name("pi"), "pi", "KALO_PI_PATH");
        assert!(engine.contains("scripts/build-engine.sh"), "{engine}");
        assert!(engine.contains(TARGET_TRIPLE), "{engine}");
        assert!(engine.contains("KALO_PI_PATH"), "{engine}");

        let gw = not_found(&file_name("kalo-gateway"), "kalo-gateway", "KALO_GATEWAY_PATH");
        assert!(gw.contains("scripts/build-gateway.sh"), "{gw}");
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_is_rejected_with_chmod_hint() {
        let dir = TempDir::new("noexec");
        let p = dir.0.join("pi");
        fs::write(&p, b"payload").unwrap();
        let err = usable(&p).unwrap_err();
        assert!(err.contains("chmod +x"), "{err}");
    }

    #[test]
    fn executable_file_is_accepted() {
        let dir = TempDir::new("exec");
        let exe = write_exe(&dir.0, "pi");
        assert!(usable(&exe).is_ok());
    }
}
