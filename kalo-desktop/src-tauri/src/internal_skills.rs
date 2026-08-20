//! Bundled internal skills: `internal-skills/` (repo root) → `~/.kalo/skills/`.
//!
//! The source of truth is plain markdown in the repo, bundled into the
//! installer as the `internal-skills` resource. Every app start installs it
//! into the user skills root, where it is indistinguishable from a
//! hand-written skill (settings page can read / edit / delete it).
//!
//! Updates propagate without clobbering local edits: `.internal-skills.json`
//! in the skills root records the fingerprint of the content we last wrote,
//! so a target file that still matches it can be safely replaced, while one
//! that drifted (the user edited it) is left alone. `install(true)` is the
//! escape hatch — force everything back to the bundled version.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Fingerprint bookkeeping, kept in the skills root next to the skills
/// themselves. Dot-prefixed so `skills.rs` scanning skips it.
const MANIFEST_NAME: &str = ".internal-skills.json";

/// What one `install` pass did, per skill-relative path (`math/SKILL.md`).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    /// Target did not exist.
    pub installed: Vec<String>,
    /// Target existed, was unmodified, and the bundled content differed.
    pub updated: Vec<String>,
    /// Target carries local edits — left untouched.
    pub skipped: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    /// rel path (forward slashes) → fingerprint of the content we wrote.
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// `~/.kalo/skills` — same root as `skills.rs` uses for the user scope.
fn user_skills_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("skills"))
}

/// Locate the bundled skills directory, mirroring `session.rs`'s sidecar
/// lookup: explicit override, then next to the executable (installed app),
/// with the repo checkout as the fallback.
///
/// Debug builds check the checkout *first*: `tauri build`/`tauri dev` stage
/// resources next to the exe at build-script time, so that copy goes stale
/// when a skill file is added and cargo sees no reason to re-run. In dev the
/// repo is the truth.
fn source_dir() -> Option<PathBuf> {
    if let Ok(over) = std::env::var("KALO_INTERNAL_SKILLS_DIR") {
        let p = PathBuf::from(over);
        if p.is_dir() {
            return Some(p);
        }
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("internal-skills");
    if cfg!(debug_assertions) && repo.is_dir() {
        return Some(repo.clone());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("internal-skills");
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    if repo.is_dir() {
        return Some(repo);
    }
    None
}

/// FNV-1a (64-bit) over the raw bytes, hex-encoded. Not cryptographic — this
/// only answers "is this the same text we wrote last time", and unlike
/// `DefaultHasher` its output is stable across Rust versions, so a toolchain
/// upgrade cannot make every skill look locally modified.
pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Collect every file under `<src>/<skill>/**`, as (rel path with forward
/// slashes, absolute path). Top-level files (the directory's own README) are
/// deliberately excluded: only skill subdirectories get installed.
fn bundled_files(src: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(src) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !path.is_dir() {
            continue;
        }
        collect_files(&path, &name, &mut out);
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn collect_files(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Dotfiles are private to the source tree; `__pycache__` is build
        // output. Both were shipping until the first release build showed
        // `market-data/lib/__pycache__/*.pyc` in the manifest — bytecode
        // compiled by whichever interpreter the developer happened to run,
        // installed onto machines that will never use it.
        if name.starts_with('.') || name == "__pycache__" || name.ends_with(".pyc") {
            continue;
        }
        let rel = format!("{prefix}/{name}");
        if path.is_dir() {
            collect_files(&path, &rel, out);
        } else {
            out.push((rel, path));
        }
    }
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

/// Install (or refresh) the bundled skills. `force` overwrites local edits.
///
/// A missing source directory is an error, which only the explicit reinstall
/// command surfaces to the user; startup just logs it.
pub fn install(force: bool) -> Result<InstallReport, String> {
    let src = source_dir().ok_or_else(|| {
        "bundled skills directory not found; set KALO_INTERNAL_SKILLS_DIR".to_string()
    })?;
    install_into(&src, &user_skills_root()?, force)
}

/// The install pass itself, with both roots injected so it is testable.
///
/// Individual file failures (unwritable target, unreadable source) are
/// skipped rather than aborting the pass: one broken skill must not keep the
/// others from installing.
fn install_into(src: &Path, root: &Path, force: bool) -> Result<InstallReport, String> {
    fs::create_dir_all(root).map_err(|e| format!("failed to create {}: {e}", root.display()))?;

    let mut manifest = read_manifest(root);
    let mut report = InstallReport::default();
    let mut manifest_dirty = false;

    for (rel, source_path) in bundled_files(src) {
        let Ok(content) = fs::read(&source_path) else {
            continue;
        };
        let bundled = fingerprint(&content);
        let target = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));

        let existing = fs::read(&target).ok();
        let action = match &existing {
            // Fresh install.
            None => Action::Write,
            Some(bytes) if force => {
                if fingerprint(bytes) == bundled {
                    Action::Record(bundled.clone())
                } else {
                    Action::Update
                }
            }
            Some(bytes) => {
                let current = fingerprint(bytes);
                if current == bundled {
                    // Already up to date; claim it if the manifest predates us.
                    Action::Record(bundled.clone())
                } else if manifest.files.get(&rel) == Some(&current) {
                    // Untouched since we wrote it — safe to update.
                    Action::Update
                } else {
                    Action::Skip
                }
            }
        };

        match action {
            Action::Write | Action::Update => {
                if let Some(dir) = target.parent() {
                    if fs::create_dir_all(dir).is_err() {
                        continue;
                    }
                }
                if fs::write(&target, &content).is_err() {
                    continue;
                }
                manifest.files.insert(rel.clone(), bundled);
                manifest_dirty = true;
                if matches!(action, Action::Update) {
                    report.updated.push(rel);
                } else {
                    report.installed.push(rel);
                }
            }
            Action::Record(fp) => {
                if manifest.files.get(&rel) != Some(&fp) {
                    manifest.files.insert(rel, fp);
                    manifest_dirty = true;
                }
            }
            Action::Skip => report.skipped.push(rel),
        }
    }

    if manifest_dirty {
        write_manifest(root, &manifest);
    }
    Ok(report)
}

enum Action {
    /// Target missing (or forced) — write it.
    Write,
    /// Target unmodified since our last write — replace with the new version.
    Update,
    /// Content already matches; only the manifest needs the fingerprint.
    Record(String),
    /// Locally edited — leave it alone.
    Skip,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two directories under the OS temp dir: a fake bundle and a fake
    /// `~/.kalo/skills`. `tag` keeps concurrent tests from colliding.
    fn dirs(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("kalo-internal-skills-{tag}"));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("bundle");
        let root = base.join("skills");
        fs::create_dir_all(src.join("math")).unwrap();
        fs::create_dir_all(&root).unwrap();
        (src, root)
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn installs_then_propagates_updates_but_keeps_local_edits() {
        let (src, root) = dirs("update");
        write(&src.join("math/SKILL.md"), "v1");
        write(&src.join("README.md"), "not a skill");

        // First pass: fresh install. Top-level files stay out of the install.
        let r = install_into(&src, &root, false).unwrap();
        assert_eq!(r.installed, vec!["math/SKILL.md"]);
        assert!(r.updated.is_empty() && r.skipped.is_empty());
        assert!(!root.join("README.md").exists());
        assert_eq!(fs::read_to_string(root.join("math/SKILL.md")).unwrap(), "v1");

        // Re-running with unchanged content is a no-op.
        let r = install_into(&src, &root, false).unwrap();
        assert!(r.installed.is_empty() && r.updated.is_empty() && r.skipped.is_empty());

        // Bundled content moves on: the untouched target follows it.
        write(&src.join("math/SKILL.md"), "v2");
        let r = install_into(&src, &root, false).unwrap();
        assert_eq!(r.updated, vec!["math/SKILL.md"]);
        assert_eq!(fs::read_to_string(root.join("math/SKILL.md")).unwrap(), "v2");

        // Local edit + another bundled change: the edit wins.
        write(&root.join("math/SKILL.md"), "mine");
        write(&src.join("math/SKILL.md"), "v3");
        let r = install_into(&src, &root, false).unwrap();
        assert_eq!(r.skipped, vec!["math/SKILL.md"]);
        assert_eq!(fs::read_to_string(root.join("math/SKILL.md")).unwrap(), "mine");

        // Forced reinstall discards it.
        let r = install_into(&src, &root, true).unwrap();
        assert_eq!(r.updated, vec!["math/SKILL.md"]);
        assert_eq!(fs::read_to_string(root.join("math/SKILL.md")).unwrap(), "v3");
    }

    #[test]
    fn adopts_files_installed_before_the_manifest_existed() {
        // Upgrade path from the versions that installed skills without
        // bookkeeping: identical content is claimed, edited content is not.
        let (src, root) = dirs("adopt");
        write(&src.join("math/SKILL.md"), "v1");
        fs::create_dir_all(src.join("paper-reading")).unwrap();
        write(&src.join("paper-reading/SKILL.md"), "v1");
        write(&root.join("math/SKILL.md"), "v1");
        write(&root.join("paper-reading/SKILL.md"), "hand-tuned");

        let r = install_into(&src, &root, false).unwrap();
        assert!(r.installed.is_empty() && r.updated.is_empty());
        assert_eq!(r.skipped, vec!["paper-reading/SKILL.md"]);

        // The adopted one now tracks the bundle; the edited one still does not.
        write(&src.join("math/SKILL.md"), "v2");
        write(&src.join("paper-reading/SKILL.md"), "v2");
        let r = install_into(&src, &root, false).unwrap();
        assert_eq!(r.updated, vec!["math/SKILL.md"]);
        assert_eq!(r.skipped, vec!["paper-reading/SKILL.md"]);
    }

    #[test]
    fn installs_nested_files_and_skips_dotfiles() {
        let (src, root) = dirs("nested");
        write(&src.join("math/SKILL.md"), "s");
        write(&src.join("math/scripts/check.py"), "print(1)");
        write(&src.join("math/.draft.md"), "wip");
        // Bytecode from whoever ran the script last; not ours to ship.
        write(&src.join("math/scripts/__pycache__/check.cpython-312.pyc"), "\0\0");

        let r = install_into(&src, &root, false).unwrap();
        assert_eq!(r.installed, vec!["math/SKILL.md", "math/scripts/check.py"]);
        assert!(!root.join("math/.draft.md").exists());
        assert!(!root.join("math/scripts/__pycache__").exists());
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
        assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
        assert_eq!(fingerprint(b"").len(), 16);
    }

    #[test]
    fn resolves_the_repo_bundle_in_debug_builds() {
        // Guards the `internal-skills/` location and the debug-first lookup:
        // moving or renaming the directory must fail here, not silently at
        // runtime with zero skills installed.
        let dir = source_dir().expect("bundled skills directory not found");
        assert!(dir.join("math").join("SKILL.md").is_file(), "{}", dir.display());
    }
}
