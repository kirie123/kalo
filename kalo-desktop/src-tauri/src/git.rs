//! Git awareness for the file panel — read-only.
//!
//! Three `git` invocations, no libgit2: the CLI already interprets
//! `.gitignore`, submodules, sparse checkout and every `include`d config
//! exactly the way the user and the agent see it in a terminal.
//!
//! - `rev-parse --show-toplevel` → is this a repo, and where is its root
//! - `status --porcelain=v2 --branch -z` → branch, ahead/behind, per-path state
//! - `diff --numstat -z HEAD` → added/removed line counts per path
//!
//! `-z` is not optional: without it git applies `core.quotepath` and every
//! non-ASCII path comes back as `"\346\226\207"`. With it, paths are verbatim
//! and NUL-separated.
//!
//! Nothing here writes to the repository. Staging and committing stay with
//! whoever already owns them (the agent's `bash`, the user's terminal), so the
//! panel never races them for `index.lock`.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::proc;

/// Cap on reported entries. A working tree with more changes than this is not
/// something a tree view can usefully show; the flag says the list is a prefix.
const MAX_ENTRIES: usize = 5_000;
/// Cap on one file's diff text handed to the UI.
const MAX_DIFF_BYTES: usize = 512 * 1024;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Absolute path of the work-tree root, native separators.
    pub repo_root: String,
    /// Branch name, or a short oid when detached.
    pub branch: String,
    pub detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// True before the first commit exists (`branch.oid` is `(initial)`).
    pub initial: bool,
    pub entries: Vec<GitEntry>,
    /// True when [`MAX_ENTRIES`] stopped the parse; `entries` is a prefix.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEntry {
    /// Path relative to `repo_root`, posix separators (as git prints it).
    pub rel_path: String,
    /// Absolute path, native separators — the key the file tree matches on.
    pub path: String,
    /// Staged-side status letter, "." when unmodified.
    pub index: String,
    /// Work-tree-side status letter, "." when unmodified.
    pub worktree: String,
    pub untracked: bool,
    /// True for the collapsed `? dir/` record git emits under `-unormal`.
    pub is_dir: bool,
    pub conflicted: bool,
    pub submodule: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    pub binary: bool,
}

/// Full status snapshot for the repository containing `cwd`.
///
/// `Ok(None)` means "there is nothing to show": not a repository, or git is
/// not installed. Both are ordinary states for a directory the user browsed
/// to, so neither is an error the UI should surface.
pub fn git_status(cwd: &str) -> Result<Option<GitStatus>, String> {
    let Some(root) = repo_root(cwd) else {
        return Ok(None);
    };
    // Past this point we know it is a repo, so a failure is worth reporting.
    let raw = git(
        &root,
        &["status", "--porcelain=v2", "--branch", "-z", "-unormal"],
    )?;
    let mut status = parse_porcelain(&raw, Path::new(&root));
    status.repo_root = root.clone();

    // Line counts are a nicety: a failure here leaves the counts unset rather
    // than losing the whole status.
    let numstat = if status.initial {
        git(&root, &["diff", "--numstat", "-z", "--no-ext-diff"])
    } else {
        git(&root, &["diff", "--numstat", "-z", "--no-ext-diff", "HEAD"])
    };
    if let Ok(raw) = numstat {
        apply_numstat(&mut status, &parse_numstat(&raw));
    }
    Ok(Some(status))
}

/// Diff of one path against `HEAD` — staged and unstaged changes together,
/// which is the "what did this turn actually change" view the panel wants.
///
/// An untracked file has no diff and answers with an empty string.
pub fn git_diff(cwd: &str, rel_path: &str) -> Result<String, String> {
    let Some(root) = repo_root(cwd) else {
        return Err("不是 git 仓库".to_string());
    };
    let initial = git(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err();
    let mut args = vec!["diff", "--no-ext-diff", "--no-color"];
    if !initial {
        args.push("HEAD");
    }
    args.push("--");
    args.push(rel_path);
    let mut out = git(&root, &args)?;
    if out.len() > MAX_DIFF_BYTES {
        // Cut on a char boundary, then on the last complete line.
        let mut end = MAX_DIFF_BYTES;
        while end > 0 && !out.is_char_boundary(end) {
            end -= 1;
        }
        let cut = out[..end].rfind('\n').map(|i| i + 1).unwrap_or(end);
        out.truncate(cut);
        out.push_str("\n…（diff 过大，已截断）\n");
    }
    Ok(out)
}

/// Work-tree root of `cwd`, or None when `cwd` is not in a repository (or git
/// is missing).
fn repo_root(cwd: &str) -> Option<String> {
    let out = git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let root = out.trim();
    if root.is_empty() {
        return None;
    }
    Some(root.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// Run git in `dir`, returning stdout. Non-zero exit is an Err carrying
/// stderr, which is how "not a repository" reaches [`repo_root`].
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).arg("--no-optional-locks").args(args);
    cmd.stdin(std::process::Stdio::null());
    proc::no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} 失败", args.first().copied().unwrap_or("?"))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `status --porcelain=v2 --branch -z`.
///
/// Every record — header lines included — is NUL-terminated. Record shapes:
///
/// ```text
/// # branch.oid <oid> | (initial)
/// # branch.head <name> | (detached)
/// # branch.upstream <name>
/// # branch.ab +<ahead> -<behind>
/// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
/// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
/// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
/// ? <path>
/// ```
///
/// The `2 ` record is the trap: under `-z` the original path is its own
/// NUL-terminated field, not a space-separated column.
fn parse_porcelain(raw: &str, root: &Path) -> GitStatus {
    let mut status = GitStatus {
        branch: String::new(),
        ..Default::default()
    };
    // `branch.oid` may arrive before `branch.head`, so the detached short oid
    // can only be resolved once every header has been seen.
    let mut oid = String::new();
    let mut records = raw.split('\0');
    while let Some(rec) = records.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(header) = rec.strip_prefix("# ") {
            parse_header(header, &mut status, &mut oid);
            continue;
        }
        if status.entries.len() >= MAX_ENTRIES {
            status.truncated = true;
            break;
        }
        let (kind, rest) = match rec.split_once(' ') {
            Some(pair) => pair,
            None => continue,
        };
        let entry = match kind {
            "1" => parse_changed(rest, root, false),
            "2" => {
                // The following field is the original path; consume it even if
                // the record itself turns out unparseable.
                let orig = records.next().unwrap_or_default().to_string();
                parse_changed(rest, root, true).map(|mut e| {
                    e.renamed_from = if orig.is_empty() { None } else { Some(orig) };
                    e
                })
            }
            "u" => parse_unmerged(rest, root),
            "?" => Some(untracked(rest, root)),
            // "!" (ignored) is never requested; anything else is a format we
            // do not know and would rather skip than guess at.
            _ => None,
        };
        if let Some(entry) = entry {
            status.entries.push(entry);
        }
    }
    if status.detached {
        status.branch = if oid.is_empty() {
            "detached".to_string()
        } else {
            oid.chars().take(8).collect()
        };
    } else if status.branch.is_empty() {
        status.branch = "(no branch)".to_string();
    }
    status
}

fn parse_header(header: &str, status: &mut GitStatus, oid: &mut String) {
    let (key, value) = match header.split_once(' ') {
        Some(pair) => pair,
        None => return,
    };
    match key {
        "branch.oid" => {
            if value == "(initial)" {
                status.initial = true;
            } else {
                *oid = value.to_string();
            }
        }
        "branch.head" => {
            if value == "(detached)" {
                status.detached = true;
            } else {
                status.branch = value.to_string();
            }
        }
        "branch.upstream" => status.upstream = Some(value.to_string()),
        "branch.ab" => {
            for part in value.split_whitespace() {
                let (sign, num) = part.split_at(1);
                let n = num.parse().unwrap_or(0);
                match sign {
                    "+" => status.ahead = n,
                    "-" => status.behind = n,
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// `1 `/`2 ` records: fixed columns, then the path. A renamed record carries
/// one extra column (`<X><score>`) before the path.
fn parse_changed(rest: &str, root: &Path, renamed: bool) -> Option<GitEntry> {
    let mut cols = rest.splitn(if renamed { 9 } else { 8 }, ' ');
    let xy = cols.next()?;
    let sub = cols.next()?;
    // mH mI mW hH hI, plus <X><score> for renames.
    for _ in 0..(if renamed { 6 } else { 5 }) {
        cols.next()?;
    }
    let path = cols.next()?;
    if path.is_empty() {
        return None;
    }
    let (index, worktree) = split_xy(xy);
    Some(GitEntry {
        rel_path: path.to_string(),
        path: abs_of(root, path),
        index,
        worktree,
        untracked: false,
        is_dir: false,
        conflicted: false,
        submodule: sub.starts_with('S'),
        renamed_from: None,
        added: None,
        removed: None,
        binary: false,
    })
}

/// `u ` records: three stage modes and three oids instead of two of each —
/// `<XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`, ten columns.
fn parse_unmerged(rest: &str, root: &Path) -> Option<GitEntry> {
    let mut cols = rest.splitn(10, ' ');
    let xy = cols.next()?;
    let sub = cols.next()?;
    // m1 m2 m3 mW h1 h2 h3
    for _ in 0..7 {
        cols.next()?;
    }
    let path = cols.next()?;
    if path.is_empty() {
        return None;
    }
    let (index, worktree) = split_xy(xy);
    Some(GitEntry {
        rel_path: path.to_string(),
        path: abs_of(root, path),
        index,
        worktree,
        untracked: false,
        is_dir: false,
        conflicted: true,
        submodule: sub.starts_with('S'),
        renamed_from: None,
        added: None,
        removed: None,
        binary: false,
    })
}

/// `? ` records. Under `-unormal` a wholly untracked directory arrives as one
/// record with a trailing slash; the slash is stripped and `is_dir` set, so
/// prefix matching in the UI works the same for both shapes.
fn untracked(path: &str, root: &Path) -> GitEntry {
    let is_dir = path.ends_with('/');
    let rel = path.trim_end_matches('/');
    GitEntry {
        rel_path: rel.to_string(),
        path: abs_of(root, rel),
        index: ".".to_string(),
        worktree: "?".to_string(),
        untracked: true,
        is_dir,
        conflicted: false,
        submodule: false,
        renamed_from: None,
        added: None,
        removed: None,
        binary: false,
    }
}

/// The two status letters of an `<XY>` column, defaulting to unmodified.
fn split_xy(xy: &str) -> (String, String) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    (x.to_string(), y.to_string())
}

/// Join a git-reported (posix) relative path onto the root with native
/// separators, so the result matches what `list_dir` hands the frontend.
fn abs_of(root: &Path, rel: &str) -> String {
    let native = if std::path::MAIN_SEPARATOR == '/' {
        rel.to_string()
    } else {
        rel.replace('/', std::path::MAIN_SEPARATOR_STR)
    };
    root.join(native).to_string_lossy().into_owned()
}

/// Per-path `(added, removed, binary)` from `diff --numstat -z`.
///
/// Records are `<added>\t<removed>\t<path>`; a binary file reports `-` for
/// both counts. A rename leaves the path field empty and follows with two
/// extra NUL fields (original, then new path) — the new path is the one that
/// exists on disk, so that is the key.
fn parse_numstat(raw: &str) -> HashMap<String, (Option<u32>, Option<u32>, bool)> {
    let mut out = HashMap::new();
    let mut fields = raw.split('\0');
    while let Some(rec) = fields.next() {
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(3, '\t');
        let Some(added) = parts.next() else { continue };
        let Some(removed) = parts.next() else { continue };
        let path = match parts.next() {
            Some(p) if !p.is_empty() => p.to_string(),
            // Rename: original path, then new path.
            _ => {
                let _orig = fields.next();
                match fields.next() {
                    Some(p) if !p.is_empty() => p.to_string(),
                    _ => continue,
                }
            }
        };
        let binary = added == "-" || removed == "-";
        out.insert(
            path,
            (added.parse().ok(), removed.parse().ok(), binary),
        );
    }
    out
}

fn apply_numstat(
    status: &mut GitStatus,
    counts: &HashMap<String, (Option<u32>, Option<u32>, bool)>,
) {
    for entry in &mut status.entries {
        if let Some((added, removed, binary)) = counts.get(&entry.rel_path) {
            entry.added = *added;
            entry.removed = *removed;
            entry.binary = *binary;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> &'static Path {
        Path::new(if cfg!(windows) { "C:\\repo" } else { "/repo" })
    }

    /// Build NUL-terminated porcelain output from record strings.
    fn z(records: &[&str]) -> String {
        records.iter().map(|r| format!("{r}\0")).collect()
    }

    #[test]
    fn parses_branch_header() {
        let raw = z(&[
            "# branch.oid abc123",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
        ]);
        let s = parse_porcelain(&raw, root());
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert!(!s.detached && !s.initial);
    }

    #[test]
    fn detached_head_reports_short_oid() {
        // Real output puts branch.oid first, so the short oid must survive
        // learning about detachment only afterwards. Both orders must work.
        for raw in [
            z(&["# branch.oid 0123456789abcdef", "# branch.head (detached)"]),
            z(&["# branch.head (detached)", "# branch.oid 0123456789abcdef"]),
        ] {
            let s = parse_porcelain(&raw, root());
            assert!(s.detached);
            assert_eq!(s.branch, "01234567");
        }
    }

    #[test]
    fn empty_repo_is_initial() {
        let raw = z(&["# branch.oid (initial)", "# branch.head main"]);
        let s = parse_porcelain(&raw, root());
        assert!(s.initial);
        assert_eq!(s.branch, "main");
    }

    #[test]
    fn parses_ordinary_change() {
        let raw = z(&["1 .M N... 100644 100644 100644 aaa bbb src/app.ts"]);
        let s = parse_porcelain(&raw, root());
        assert_eq!(s.entries.len(), 1);
        let e = &s.entries[0];
        assert_eq!(e.rel_path, "src/app.ts");
        assert_eq!((e.index.as_str(), e.worktree.as_str()), (".", "M"));
        assert!(!e.untracked && !e.conflicted && !e.submodule);
        assert!(e.path.ends_with("app.ts"));
    }

    #[test]
    fn parses_rename_with_separate_orig_path_field() {
        let raw = z(&[
            "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts",
            "old/name.ts",
            "1 .M N... 100644 100644 100644 ccc ddd after.ts",
        ]);
        let s = parse_porcelain(&raw, root());
        assert_eq!(s.entries.len(), 2, "the orig-path field must not become an entry");
        assert_eq!(s.entries[0].rel_path, "new/name.ts");
        assert_eq!(s.entries[0].renamed_from.as_deref(), Some("old/name.ts"));
        assert_eq!(s.entries[0].index, "R");
        assert_eq!(s.entries[1].rel_path, "after.ts");
    }

    #[test]
    fn parses_cjk_path_verbatim() {
        let raw = z(&["1 .M N... 100644 100644 100644 aaa bbb 文档/设计 稿.md"]);
        let s = parse_porcelain(&raw, root());
        assert_eq!(s.entries[0].rel_path, "文档/设计 稿.md");
    }

    #[test]
    fn parses_untracked_file_and_collapsed_dir() {
        let raw = z(&["? scratch.md", "? build/"]);
        let s = parse_porcelain(&raw, root());
        assert_eq!(s.entries.len(), 2);
        assert!(s.entries[0].untracked && !s.entries[0].is_dir);
        assert_eq!(s.entries[1].rel_path, "build", "trailing slash is stripped");
        assert!(s.entries[1].is_dir);
    }

    #[test]
    fn parses_unmerged_and_submodule() {
        let raw = z(&[
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
            "1 .M S.M. 160000 160000 160000 aaa bbb vendor/lib",
        ]);
        let s = parse_porcelain(&raw, root());
        assert!(s.entries[0].conflicted);
        assert_eq!(s.entries[0].rel_path, "conflict.ts");
        assert!(s.entries[1].submodule);
    }

    #[test]
    fn caps_entries_and_flags_truncation() {
        let mut records = Vec::new();
        for i in 0..(MAX_ENTRIES + 10) {
            records.push(format!("? f{i}.md"));
        }
        let raw: String = records.iter().map(|r| format!("{r}\0")).collect();
        let s = parse_porcelain(&raw, root());
        assert_eq!(s.entries.len(), MAX_ENTRIES);
        assert!(s.truncated);
    }

    #[test]
    fn numstat_counts_and_binary() {
        let raw = "12\t3\tsrc/app.ts\0-\t-\ticon.png\0";
        let counts = parse_numstat(raw);
        assert_eq!(counts["src/app.ts"], (Some(12), Some(3), false));
        assert_eq!(counts["icon.png"], (None, None, true));
    }

    #[test]
    fn numstat_rename_uses_the_new_path() {
        // Split so the NUL before "5" cannot be misread as an octal escape.
        let raw = concat!("4\t2\t\0old/name.ts\0new/name.ts\0", "5\t1\tplain.ts\0");
        let counts = parse_numstat(raw);
        assert_eq!(counts["new/name.ts"], (Some(4), Some(2), false));
        assert!(!counts.contains_key("old/name.ts"));
        // The record after a rename must not be swallowed by it.
        assert_eq!(counts["plain.ts"], (Some(5), Some(1), false));
    }

    #[test]
    fn numstat_is_applied_to_matching_entries() {
        let raw = z(&["1 .M N... 100644 100644 100644 aaa bbb src/app.ts"]);
        let mut s = parse_porcelain(&raw, root());
        apply_numstat(&mut s, &parse_numstat("7\t2\tsrc/app.ts\0"));
        assert_eq!(s.entries[0].added, Some(7));
        assert_eq!(s.entries[0].removed, Some(2));
    }
}
