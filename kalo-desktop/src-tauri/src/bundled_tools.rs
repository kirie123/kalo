//! Bundled tools: the pinned `ripgrep` binary the installer ships.
//!
//! The engine's system prompt steers the model to `rg`; without a shipped
//! binary a release silently degrades to `grep -r` over the whole workspace
//! (doc/2026-10-02-后台bash-PATH修复与ripgrep随包分发.md). The binary is
//! staged at build time by `scripts/fetch-ripgrep.mjs` next to the sidecars
//! (`binaries/rg-<target-triple>[.exe]`) and bundled through the tauri
//! platform configs. This module copies it into `~/.kalo/agent/bin` at
//! startup — the engine's `getBinDir()`, already first on PATH for bash and
//! the tool layer — so `rg` works offline on a fresh install.
//!
//! Updates must not clobber user intent: `.kalo-bundled-tools.json` in the
//! bin dir records the fingerprint of the bytes we last wrote, exactly like
//! [`crate::internal_skills`]. A target that still matches it follows the
//! bundle; one that drifted (the user replaced rg, or the engine's own
//! `ensureTool("rg")` downloaded one at runtime) is left alone.
//! `install(true)` is the force escape hatch.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::sidecar;

/// Stem of the tool this module installs; the staged file is
/// `rg-<target-triple>[.exe]` and the runtime target is `rg[.exe]`.
const TOOL: &str = "rg";

/// Env override for tests / external builds; points straight at a binary.
const ENV_OVERRIDE: &str = "KALO_BUNDLED_RG";

/// Fingerprint bookkeeping, kept in the bin dir next to the tools. Dot
/// prefixed so nothing that scans the directory mistakes it for a tool.
const MANIFEST_NAME: &str = ".kalo-bundled-tools.json";

/// What one `install` pass did, per tool name (`rg`).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    /// Target did not exist.
    pub installed: Vec<String>,
    /// Target existed, was unmodified, and the bundled binary differed.
    pub updated: Vec<String>,
    /// Target carries local edits — left untouched.
    pub skipped: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    /// tool name → fingerprint of the bytes we wrote.
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// `~/.kalo/agent/bin` — the engine's `getBinDir()`.
fn bin_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("agent").join("bin"))
}

/// Name a tool has in the bin dir on this platform (`rg` / `rg.exe`).
fn target_name(tool: &str) -> String {
    format!("{tool}{}", std::env::consts::EXE_SUFFIX)
}

fn read_manifest(root: &Path) -> Manifest {
    fs::read_to_string(root.join(MANIFEST_NAME))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_manifest(root: &Path, manifest: &Manifest) {
    if let Ok(text) = serde_json::to_string_pretty(manifest) {
        let _ = fs::write(root.join(MANIFEST_NAME), text);
    }
}

/// Write `content` to `target` so that a running binary cannot block the
/// update: stage a sibling temp file, then swap it in.
///
/// On Windows an in-use executable cannot be overwritten in place, and the
/// engine may well have an `rg` child running while the app starts. Renaming
/// a completed temp file over the target is the closest thing to an atomic
/// replace both platforms share.
fn write_binary(target: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = target.with_extension("tmp");
    fs::write(&tmp, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755));
    }
    #[cfg(windows)]
    if target.exists() {
        // `rename` does not replace an existing file on Windows.
        fs::remove_file(target)?;
    }
    fs::rename(&tmp, target)
}

/// Install (or refresh) the bundled tools. `force` overwrites local changes.
///
/// A missing bundled binary is an error, which only an explicit call surfaces:
/// startup just logs it, so a dev checkout without the staged rg still runs.
pub fn install(force: bool) -> Result<InstallReport, String> {
    let src = sidecar::resolve(TOOL, ENV_OVERRIDE)?;
    install_into(&src, &bin_dir()?, TOOL, force)
}

/// The install pass itself, with both roots injected so it is testable.
fn install_into(src: &Path, root: &Path, tool: &str, force: bool) -> Result<InstallReport, String> {
    fs::create_dir_all(root).map_err(|e| format!("failed to create {}: {e}", root.display()))?;

    let content = fs::read(src).map_err(|e| format!("failed to read {}: {e}", src.display()))?;
    let bundled = crate::internal_skills::fingerprint(&content);
    let target = root.join(target_name(tool));

    let mut manifest = read_manifest(root);
    let mut report = InstallReport::default();
    let mut manifest_dirty = false;

    let existing = fs::read(&target).ok();
    enum Action {
        /// Target missing — write it.
        Write,
        /// Target unmodified since our last write — replace with the new build.
        Update,
        /// Content already matches; only the manifest needs the fingerprint.
        Record(String),
        /// Locally replaced — leave it alone.
        Skip,
    }
    let action = match &existing {
        None => Action::Write,
        Some(bytes) if force => {
            if crate::internal_skills::fingerprint(bytes) == bundled {
                Action::Record(bundled.clone())
            } else {
                Action::Update
            }
        }
        Some(bytes) => {
            let current = crate::internal_skills::fingerprint(bytes);
            if current == bundled {
                // Already up to date; claim it if the manifest predates us.
                Action::Record(bundled.clone())
            } else if manifest.files.get(tool) == Some(&current) {
                // Untouched since we wrote it — safe to update.
                Action::Update
            } else {
                Action::Skip
            }
        }
    };

    match action {
        Action::Write | Action::Update => {
            if write_binary(&target, &content).is_err() {
                return Ok(report); // one failed tool must not abort the pass
            }
            manifest.files.insert(tool.to_string(), bundled);
            manifest_dirty = true;
            if matches!(action, Action::Update) {
                report.updated.push(tool.to_string());
            } else {
                report.installed.push(tool.to_string());
            }
        }
        Action::Record(fp) => {
            if manifest.files.get(tool) != Some(&fp) {
                manifest.files.insert(tool.to_string(), fp);
                manifest_dirty = true;
            }
        }
        Action::Skip => report.skipped.push(tool.to_string()),
    }

    if manifest_dirty {
        write_manifest(root, &manifest);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two directories under the OS temp dir: a fake bundle and a fake
    /// `~/.kalo/agent/bin`. `tag` keeps concurrent tests from colliding.
    fn dirs(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("kalo-bundled-tools-{tag}"));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("bundle");
        let root = base.join("bin");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&root).unwrap();
        (src, root)
    }

    fn write(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
    }

    #[test]
    fn installs_updates_and_keeps_user_replacements() {
        let (src, root) = dirs("update");
        let bundle = src.join("rg");
        write(&bundle, "v1");

        // Fresh install puts the binary under the platform's target name.
        let r = install_into(&bundle, &root, "rg", false).unwrap();
        assert_eq!(r.installed, vec!["rg"]);
        assert!(r.updated.is_empty() && r.skipped.is_empty());
        let target = root.join(target_name("rg"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "v1");
        assert!(root.join(MANIFEST_NAME).is_file());

        // Re-running with unchanged content is a no-op.
        let r = install_into(&bundle, &root, "rg", false).unwrap();
        assert!(r.installed.is_empty() && r.updated.is_empty() && r.skipped.is_empty());

        // A new pinned build propagates over the untouched target.
        write(&bundle, "v2");
        let r = install_into(&bundle, &root, "rg", false).unwrap();
        assert_eq!(r.updated, vec!["rg"]);
        assert_eq!(fs::read_to_string(&target).unwrap(), "v2");

        // A user replacement (or the engine's runtime `ensureTool`) wins.
        write(&target, "my own rg");
        write(&bundle, "v3");
        let r = install_into(&bundle, &root, "rg", false).unwrap();
        assert_eq!(r.skipped, vec!["rg"]);
        assert_eq!(fs::read_to_string(&target).unwrap(), "my own rg");

        // Force discards it.
        let r = install_into(&bundle, &root, "rg", true).unwrap();
        assert_eq!(r.updated, vec!["rg"]);
        assert_eq!(fs::read_to_string(&target).unwrap(), "v3");
    }

    #[test]
    fn adopts_identical_binary_installed_before_the_manifest() {
        // Upgrade path from a release that shipped rg without bookkeeping:
        // identical bytes are claimed, different bytes are left alone.
        let (src, root) = dirs("adopt");
        let bundle = src.join("rg");
        write(&bundle, "pinned");
        write(&root.join(target_name("rg")), "pinned");

        let r = install_into(&bundle, &root, "rg", false).unwrap();
        assert!(r.installed.is_empty() && r.updated.is_empty() && r.skipped.is_empty());

        // The adopted file now tracks the bundle.
        write(&bundle, "next");
        let r = install_into(&bundle, &root, "rg", false).unwrap();
        assert_eq!(r.updated, vec!["rg"]);
    }

    #[test]
    fn target_name_carries_the_platform_suffix() {
        assert_eq!(
            target_name("rg"),
            format!("rg{}", std::env::consts::EXE_SUFFIX)
        );
    }

    #[cfg(unix)]
    #[test]
    fn installed_binary_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let (src, root) = dirs("exec");
        let bundle = src.join("rg");
        write(&bundle, "payload");
        install_into(&bundle, &root, "rg", false).unwrap();
        let mode = fs::metadata(root.join(target_name("rg")))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0, "installed rg must be executable");
    }
}