//! File access for the file panel, file preview, and chat attachments.
//!
//! - `list_dir`: single-level directory listing (frontend lazy-expands).
//! - `read_file_text`: capped, lossy text preview with binary detection.
//! - `read_file_bytes`: whole file as base64, for previews that need the raw
//!   bytes (images, and the zip-based office formats the frontend unpacks).
//! - `read_attachment`: an attachment reference for a path — images are read
//!   as base64 (they ride the prompt inline), everything else is just a path
//!   for the model to `read` itself.
//! - `save_attachment_bytes`: same, for clipboard payloads that carry bytes
//!   but no path (pasted files); spills them to `~/.kalo/attachments`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

const DEFAULT_MAX_BYTES: usize = 256 * 1024;
const BINARY_PROBE_BYTES: usize = 8 * 1024;
/// Images above this go to the model as a path instead of inline bytes.
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Upper bound on a single pasted payload (bytes, before base64 decoding).
const MAX_PASTE_BYTES: usize = 32 * 1024 * 1024;
/// Cap for `read_file_bytes`. Base64 inflates by 4/3 and the payload crosses
/// the IPC bridge as a JSON string, so this is deliberately far below what the
/// text preview allows per call.
const DEFAULT_MAX_BINARY_BYTES: usize = 24 * 1024 * 1024;

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBytes {
    pub data_base64: String,
    /// Guessed from the extension, for `data:` URLs. `application/octet-stream`
    /// when unknown.
    pub mime_type: String,
    /// Size on disk, which is what the caller should report — `dataBase64`
    /// decodes to less than this when `truncated` is set.
    pub size: u64,
    /// The file exceeded the cap and nothing was read: partial bytes are
    /// useless for every consumer of this call (a zip needs its trailing
    /// central directory, an image its full stream), so an over-cap read
    /// answers empty rather than half a file.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum AttachmentData {
    #[serde(rename = "image")]
    Image {
        name: String,
        mime_type: String,
        data_base64: String,
    },
    /// A path handed to the model as-is; it reads the file itself.
    #[serde(rename = "file")]
    File { name: String, path: String },
}

/// List one level of `path`: directories first, then files, each group
/// sorted by case-insensitive name. Dotfiles and heavy build/dependency
/// directories are skipped.
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let entries =
        fs::read_dir(path).map_err(|e| format!("cannot read directory {path}: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(name.as_str(), "node_modules" | "target" | "dist" | "__pycache__")
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue; // e.g. dangling symlink; skip rather than fail the listing
        };
        let is_dir = meta.is_dir();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified_ms,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read a file as text for preview, capped at `max_bytes` (default 256KB).
/// A NUL byte in the first 8KB marks the file as binary (empty text).
pub fn read_file_text(path: &str, max_bytes: Option<usize>) -> Result<FileText, String> {
    let max = max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let file = fs::File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let mut buf = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    let truncated = buf.len() > max;
    buf.truncate(max);
    let probe = &buf[..buf.len().min(BINARY_PROBE_BYTES)];
    if probe.contains(&0) {
        return Ok(FileText {
            text: String::new(),
            truncated,
            binary: true,
        });
    }
    Ok(FileText {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
        binary: false,
    })
}

/// Extension-based MIME guess, for `data:` URLs in the preview. Only formats
/// the preview can actually show are listed; everything else is opaque bytes
/// as far as this function is concerned.
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" | "xlsm" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// Read a whole file as base64, for previews that need the bytes themselves:
/// images (rendered from a `data:` URL) and the zip-based office formats,
/// which the frontend unpacks itself.
///
/// Unlike `read_file_text` this never returns a partial file — see
/// `FileBytes::truncated`.
pub fn read_file_bytes(path: &str, max_bytes: Option<usize>) -> Result<FileBytes, String> {
    let max = max_bytes.unwrap_or(DEFAULT_MAX_BINARY_BYTES) as u64;
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| format!("cannot stat {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime_type = mime_for_ext(&ext).to_string();
    let size = meta.len();
    if size > max {
        return Ok(FileBytes {
            data_base64: String::new(),
            mime_type,
            size,
            truncated: true,
        });
    }
    let bytes = fs::read(p).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(FileBytes {
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type,
        size,
        truncated: false,
    })
}

/// Turn a path into a chat attachment. Images are read as base64 because they
/// ride the prompt inline; every other file is passed along as a path only —
/// the model reads it with its own tools, so the content never enters the
/// prompt and nothing here needs to know the format.
///
/// There is deliberately no extension whitelist: a whitelist would only block
/// files the model can read fine (`.vue`, `.gradle`, an extensionless
/// `Makefile`) without protecting anything, since we no longer parse content.
pub fn read_attachment(path: &str) -> Result<AttachmentData, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // Oversized images fall through to a path reference rather than failing:
    // the model can still read (and downscale) them on demand.
    if IMAGE_EXTS.contains(&ext.as_str()) {
        if let Some(image) = read_image_attachment(p, &name, &ext)? {
            return Ok(image);
        }
    }
    Ok(AttachmentData::File {
        name,
        path: path.to_string(),
    })
}

/// Save a pasted attachment and return its path. The webview hands over a
/// name and bytes but never a path (browser security model), so bytes must
/// land on disk before the model can be told where to read them.
///
/// The file stays: a path inside a sent message has to keep working when the
/// session is reopened weeks later, which rules out both a temp directory and
/// any age-based cleanup. `~/.kalo/attachments` therefore only grows.
pub fn save_attachment_bytes(name: &str, data_base64: &str) -> Result<AttachmentData, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    if bytes.len() > MAX_PASTE_BYTES {
        return Err("文件过大".to_string());
    }
    let file_name = sanitize_file_name(name);
    let dir = unique_attachment_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create attachment dir: {e}"))?;
    let path = dir.join(&file_name);
    fs::write(&path, &bytes).map_err(|e| format!("cannot write attachment: {e}"))?;
    Ok(AttachmentData::File {
        name: file_name,
        path: path.to_string_lossy().into_owned(),
    })
}

/// Reduce an untrusted name to a plain file name: no separators, no `..`,
/// never empty.
fn sanitize_file_name(name: &str) -> String {
    let base = name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(name)
        .trim()
        .trim_matches('.');
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    if cleaned.is_empty() {
        "attachment".to_string()
    } else {
        cleaned
    }
}

/// A directory unique per call under `~/.kalo/attachments`, so two pastes of
/// the same file name cannot clobber each other.
fn unique_attachment_dir() -> Result<PathBuf, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve home directory".to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(PathBuf::from(home)
        .join(".kalo")
        .join("attachments")
        .join(format!("{}-{nanos}-{n}", std::process::id())))
}

/// Read an image small enough to inline. `None` means "too big" — the caller
/// falls back to a path reference.
fn read_image_attachment(
    p: &Path,
    name: &str,
    ext: &str,
) -> Result<Option<AttachmentData>, String> {
    let size = fs::metadata(p)
        .map_err(|e| format!("cannot stat {}: {e}", p.display()))?
        .len();
    if size > MAX_IMAGE_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    Ok(Some(AttachmentData::Image {
        name: name.to_string(),
        mime_type: mime_for_ext(ext).to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Case-insensitive substring search over entry names under `root`, for the
/// input box's @ completion. Skips dotfiles and heavy build/dependency
/// directories; traversal is capped so huge trees cannot stall the UI.
/// Prefix matches sort before plain substring matches.
pub fn search_files(root: &str, query: &str, limit: Option<usize>) -> Result<Vec<FileMatch>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(20);
    const MAX_VISITED: usize = 50_000;

    // Validate the root before walking.
    fs::read_dir(root).map_err(|e| format!("cannot read directory {root}: {e}"))?;

    let mut out: Vec<FileMatch> = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(root)];
    let mut visited = 0usize;
    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_VISITED {
                break 'walk;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || matches!(name.as_str(), "node_modules" | "target" | "dist" | "__pycache__")
            {
                continue;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            if is_dir {
                stack.push(path.clone());
            }
            if name.to_lowercase().contains(&query) {
                out.push(FileMatch {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    is_dir,
                });
            }
        }
    }
    out.sort_by(|a, b| {
        let pa = !a.name.to_lowercase().starts_with(&query);
        let pb = !b.name.to_lowercase().starts_with(&query);
        pa.cmp(&pb)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out.truncate(limit);
    Ok(out)
}

/// Open a path with the system default handler (`reveal = false`), or show
/// it in the OS file manager (`reveal = true`: file → selected in its
/// parent folder, directory → the folder itself is opened).
/// Spawns detached and returns immediately; std::process only, no new deps.
pub fn open_path(path: &str, reveal: bool) -> Result<(), String> {
    // A directory reveals as itself; only files need to be shown inside their
    // parent. Getting this wrong is invisible on the caller's side: Explorer
    // just opens *something*.
    let is_dir = Path::new(path).is_dir();

    #[cfg(target_os = "windows")]
    {
        // Callers build paths with "/" (the frontend's convention), but Explorer
        // and `start` only understand "\" — handed forward slashes, Explorer
        // silently opens its default view instead of the requested path.
        let native = path.replace('/', "\\");
        let mut cmd = if reveal && !is_dir {
            let mut c = std::process::Command::new("explorer");
            // /select wants the verb and path in one comma-joined argument.
            c.arg(format!("/select,{native}"));
            c
        } else if reveal {
            let mut c = std::process::Command::new("explorer");
            c.arg(&native);
            c
        } else {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "start", "", native.as_str()]);
            c
        };
        cmd.spawn()
            .map_err(|e| format!("failed to open {native}: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal && !is_dir {
            cmd.arg("-R");
        }
        cmd.arg(path);
        cmd.spawn().map_err(|e| format!("failed to open {path}: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No universal "reveal" on Linux: open the parent folder instead — but
        // a directory is its own answer, so only files climb one level.
        let target = if reveal && !is_dir {
            Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string())
        } else {
            path.to_string()
        };
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("failed to open {target}: {e}"))?;
    }
    Ok(())
}

// ============================================================================
// Incremental reads and directory comparison
//
// Both are deliberately generic: no caller-specific knowledge, no file-format
// awareness. `read_text_since` serves any append-only log; `dir_diff_names`
// serves any "what changed between these two trees" question.
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSince {
    /// Bytes decoded from `offset` onwards, lossily.
    pub text: String,
    /// Offset to pass on the next call.
    pub offset: u64,
    /// Current file size; `size < offset` on entry means the file was
    /// truncated or replaced and the caller was restarted from 0.
    pub size: u64,
    /// True when the file shrank below the requested offset and this read
    /// therefore restarted from the beginning.
    pub reset: bool,
}

/// Read an append-only file from `offset` to EOF, capped at `max_bytes`
/// (default 1 MB) so one call cannot pull an unbounded log into the UI.
///
/// A missing file is not an error: it answers empty at offset 0, because
/// "the producer has not created it yet" is a normal state for a log that a
/// panel starts tailing before the process writes its first line.
pub fn read_text_since(
    path: &str,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<TextSince, String> {
    const DEFAULT_TAIL_MAX: usize = 1024 * 1024;
    let max = max_bytes.unwrap_or(DEFAULT_TAIL_MAX);
    let p = Path::new(path);
    let meta = match fs::metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TextSince {
                text: String::new(),
                offset: 0,
                size: 0,
                reset: false,
            })
        }
        Err(e) => return Err(format!("cannot stat {path}: {e}")),
    };
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let size = meta.len();
    // Shrunk below where we were: the file was rotated or rewritten, so the
    // only honest thing is to re-read it from the start and say so.
    let reset = size < offset;
    let start = if reset { 0 } else { offset };
    if start >= size {
        return Ok(TextSince {
            text: String::new(),
            offset: start,
            size,
            reset,
        });
    }

    use std::io::{Seek, SeekFrom};
    let mut file = fs::File::open(p).map_err(|e| format!("cannot open {path}: {e}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("cannot seek {path}: {e}"))?;
    let mut buf = Vec::new();
    (&mut file)
        .take(max as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read {path}: {e}"))?;

    // Never split a UTF-8 sequence across calls: back off to the last byte
    // that can start a character, and leave the remainder for the next read.
    let mut end = buf.len();
    if end == max {
        let mut back = 0;
        while back < 4 && end > 0 && (buf[end - 1] & 0xC0) == 0x80 {
            end -= 1;
            back += 1;
        }
    }
    buf.truncate(end);
    Ok(TextSince {
        text: String::from_utf8_lossy(&buf).into_owned(),
        offset: start + buf.len() as u64,
        size,
        reset,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirDiff {
    /// Relative paths present in both but differing in size or content.
    pub changed: Vec<String>,
    /// Relative paths only in `b`.
    pub added: Vec<String>,
    /// Relative paths only in `a`.
    pub removed: Vec<String>,
    /// True when the walk hit the entry cap; the lists are then a prefix.
    pub truncated: bool,
}

const DIR_DIFF_MAX_ENTRIES: usize = 20_000;
/// Files larger than this are compared by size only. Reading both sides of a
/// large pair to answer a yes/no question is not worth the IO.
const DIR_DIFF_MAX_COMPARE_BYTES: u64 = 4 * 1024 * 1024;

/// Compare two directory trees by relative path, returning what differs.
///
/// `ignore` entries are matched against each path component, so passing
/// `.git` skips the whole subtree. Content comparison is byte-exact for
/// files up to 4 MB and size-only above that.
pub fn dir_diff_names(a: &str, b: &str, ignore: &[String]) -> Result<DirDiff, String> {
    let root_a = Path::new(a);
    let root_b = Path::new(b);
    if !root_a.is_dir() {
        return Err(format!("not a directory: {a}"));
    }
    if !root_b.is_dir() {
        return Err(format!("not a directory: {b}"));
    }
    let mut files_a = Vec::new();
    let mut files_b = Vec::new();
    let trunc_a = collect_files(root_a, root_a, ignore, &mut files_a)?;
    let trunc_b = collect_files(root_b, root_b, ignore, &mut files_b)?;

    let set_a: std::collections::BTreeMap<String, u64> = files_a.into_iter().collect();
    let set_b: std::collections::BTreeMap<String, u64> = files_b.into_iter().collect();

    let mut diff = DirDiff {
        changed: Vec::new(),
        added: Vec::new(),
        removed: Vec::new(),
        truncated: trunc_a || trunc_b,
    };
    for (rel, size_a) in &set_a {
        match set_b.get(rel) {
            None => diff.removed.push(rel.clone()),
            Some(size_b) => {
                if size_a != size_b {
                    diff.changed.push(rel.clone());
                } else if *size_a <= DIR_DIFF_MAX_COMPARE_BYTES
                    && !same_bytes(&root_a.join(rel), &root_b.join(rel))
                {
                    diff.changed.push(rel.clone());
                }
            }
        }
    }
    for rel in set_b.keys() {
        if !set_a.contains_key(rel) {
            diff.added.push(rel.clone());
        }
    }
    Ok(diff)
}

/// Depth-first walk collecting `(relative posix path, size)`; returns true if
/// the entry cap stopped the walk early.
fn collect_files(
    root: &Path,
    dir: &Path,
    ignore: &[String],
    out: &mut Vec<(String, u64)>,
) -> Result<bool, String> {
    if out.len() >= DIR_DIFF_MAX_ENTRIES {
        return Ok(true);
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        // An unreadable subdirectory is not fatal: report what we can see.
        Err(_) => return Ok(false),
    };
    let mut truncated = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignore.iter().any(|i| i == &name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            truncated |= collect_files(root, &path, ignore, out)?;
        } else if meta.is_file() {
            if out.len() >= DIR_DIFF_MAX_ENTRIES {
                return Ok(true);
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|_| format!("path escaped root: {}", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, meta.len()));
        }
    }
    Ok(truncated)
}

/// Byte-exact comparison; an unreadable side counts as "differs" rather than
/// silently claiming equality.
fn same_bytes(a: &Path, b: &Path) -> bool {
    match (fs::read(a), fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}
