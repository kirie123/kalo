//! File access for the file panel, file preview, and chat attachments.
//!
//! - `list_dir`: single-level directory listing (frontend lazy-expands).
//! - `read_file_text`: capped, lossy text preview with binary detection.
//! - `read_attachment`: type-dispatched extraction (image base64, pdf,
//!   office documents, plain text) for conversation attachments.
//! - `read_attachment_bytes`: same, for clipboard payloads that carry bytes
//!   but no path (pasted files).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

const DEFAULT_MAX_BYTES: usize = 256 * 1024;
const BINARY_PROBE_BYTES: usize = 8 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ATTACHMENT_CHARS: usize = 200_000;
/// Upper bound of bytes read for a text attachment before char truncation.
const MAX_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound on a single pasted payload (bytes, before base64 decoding).
const MAX_PASTE_BYTES: usize = 32 * 1024 * 1024;

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "log", "json", "jsonl", "yaml", "yml", "xml", "ts", "tsx",
    "js", "jsx", "py", "rs", "java", "c", "cpp", "h", "hpp", "go", "sh", "bat", "ps1", "sql",
    "html", "css", "toml", "ini", "cfg", "env",
];

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
#[serde(tag = "kind")]
pub enum AttachmentData {
    #[serde(rename = "image")]
    Image {
        name: String,
        mime_type: String,
        data_base64: String,
    },
    #[serde(rename = "text")]
    Text {
        name: String,
        text: String,
        truncated: bool,
    },
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

/// Read a file as a chat attachment, dispatched by extension
/// (case-insensitive): images become base64 payloads, documents and plain
/// text become (possibly truncated) text.
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

    if IMAGE_EXTS.contains(&ext.as_str()) {
        return read_image_attachment(p, &name, &ext);
    }
    let raw = match ext.as_str() {
        "pdf" => pdf_extract::extract_text(path)
            .map_err(|e| format!("cannot extract pdf text: {e}"))?,
        "xlsx" | "xls" => extract_spreadsheet(path)?,
        "docx" => extract_docx(path)?,
        "pptx" => extract_pptx(path)?,
        "doc" | "ppt" => return Err("暂不支持旧版 Office 格式".to_string()),
        e if TEXT_EXTS.contains(&e) => read_text_lossy(p)?,
        other => return Err(format!("不支持的附件类型: .{other}")),
    };
    let (text, truncated) = truncate_chars(&raw, MAX_ATTACHMENT_CHARS);
    Ok(AttachmentData::Text {
        name,
        text,
        truncated,
    })
}

/// Read a chat attachment from raw bytes (a pasted file: the webview gives
/// us a name and the content, never a path).
///
/// The bytes are spilled to a private temp directory and handed to
/// `read_attachment`, so extension dispatch, size caps and the pdf/office
/// extractors — all of which are path-based — stay in exactly one place.
/// The directory is removed on every exit path.
pub fn read_attachment_bytes(name: &str, data_base64: &str) -> Result<AttachmentData, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    if bytes.len() > MAX_PASTE_BYTES {
        return Err("文件过大".to_string());
    }
    let file_name = sanitize_file_name(name);
    let dir = unique_temp_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create temp dir: {e}"))?;
    let path = dir.join(&file_name);
    let result = fs::write(&path, &bytes)
        .map_err(|e| format!("cannot write temp file: {e}"))
        .and_then(|()| read_attachment(&path.to_string_lossy()));
    let _ = fs::remove_dir_all(&dir);
    result
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

/// A temp directory unique per call, so two pastes of the same file name
/// cannot clobber each other.
fn unique_temp_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join("kalo-paste")
        .join(format!("{}-{nanos}-{n}", std::process::id()))
}

fn read_image_attachment(p: &Path, name: &str, ext: &str) -> Result<AttachmentData, String> {
    let size = fs::metadata(p)
        .map_err(|e| format!("cannot stat {}: {e}", p.display()))?
        .len();
    if size > MAX_IMAGE_BYTES {
        return Err("图片过大".to_string());
    }
    let bytes = fs::read(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    let mime_type = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    Ok(AttachmentData::Image {
        name: name.to_string(),
        mime_type: mime_type.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Read a (possibly large) text file lossily, pre-capped in bytes so the
/// later char truncation stays cheap.
fn read_text_lossy(p: &Path) -> Result<String, String> {
    let file =
        fs::File::open(p).map_err(|e| format!("cannot open {}: {e}", p.display()))?;
    let mut buf = Vec::new();
    file.take(MAX_ATTACHMENT_BYTES as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Concatenate all sheets: a `## <sheet>` heading line per sheet, rows of
/// tab-joined cell values.
fn extract_spreadsheet(path: &str) -> Result<String, String> {
    use calamine::Reader;
    let mut workbook: calamine::Sheets<_> = calamine::open_workbook_auto(path)
        .map_err(|e| format!("cannot open workbook: {e}"))?;
    let mut out = String::new();
    for name in workbook.sheet_names().to_vec() {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue; // unreadable sheet: keep the rest
        };
        out.push_str("## ");
        out.push_str(&name);
        out.push('\n');
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(|c| c.to_string()).collect();
            out.push_str(&cells.join("\t"));
            out.push('\n');
        }
    }
    Ok(out)
}

/// docx is a zip; text lives in `word/document.xml` inside <w:t> runs.
fn extract_docx(path: &str) -> Result<String, String> {
    let xml = read_zip_entry(path, "word/document.xml")?;
    Ok(extract_runs(&xml, "<w:t", "</w:t>", Some("</w:p>")))
}

/// pptx is a zip; text lives in <a:t> runs of `ppt/slides/slideN.xml`,
/// slides ordered numerically and separated by a blank line.
fn extract_pptx(path: &str) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("cannot read {path} as zip: {e}"))?;
    let mut slides: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(|n| {
            let num = n
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?;
            num.parse::<u32>().ok().map(|i| (i, n.to_string()))
        })
        .collect();
    slides.sort_by_key(|(i, _)| *i);
    let mut out = String::new();
    for (_, entry_name) in slides {
        let Ok(mut entry) = archive.by_name(&entry_name) else {
            continue;
        };
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() {
            continue;
        }
        let xml = String::from_utf8_lossy(&buf);
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&extract_runs(&xml, "<a:t", "</a:t>", None));
    }
    Ok(out)
}

fn read_zip_entry(path: &str, entry_name: &str) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("cannot read {path} as zip: {e}"))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| format!("{path} is missing {entry_name}"))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read {entry_name} in {path}: {e}"))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Pull text out of XML by tag scanning: contents of `<open ..>...</close>`
/// runs are appended verbatim, and each `para` closing tag (when given)
/// adds a newline. Malformed tails are ignored rather than fatal.
fn extract_runs(xml: &str, open: &str, close: &str, para: Option<&str>) -> String {
    let mut out = String::new();
    let mut pos = 0;
    while pos < xml.len() {
        let next_run = find_tag(xml, pos, open);
        let next_para = para.and_then(|p| xml[pos..].find(p).map(|i| pos + i));
        match (next_run, next_para) {
            (Some(ri), Some(pi)) if pi < ri => {
                out.push('\n');
                pos = pi + para.unwrap().len();
            }
            (Some(ri), _) => {
                let after = ri + open.len();
                let Some(gt) = xml[after..].find('>') else {
                    break;
                };
                let start = after + gt + 1;
                match xml[start..].find(close) {
                    Some(ci) => {
                        out.push_str(&xml[start..start + ci]);
                        pos = start + ci + close.len();
                    }
                    None => {
                        out.push_str(&xml[start..]);
                        break;
                    }
                }
            }
            (None, Some(pi)) => {
                out.push('\n');
                pos = pi + para.unwrap().len();
            }
            (None, None) => break,
        }
    }
    out
}

/// Find the next `<open` occurrence that is an actual tag start: the byte
/// after the prefix must be `>` or whitespace (so `<w:t` does not match
/// `<w:tab`).
fn find_tag(xml: &str, from: usize, open: &str) -> Option<usize> {
    let mut search = from;
    loop {
        let i = xml[search..].find(open).map(|o| search + o)?;
        match xml.as_bytes().get(i + open.len()) {
            Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') | None => {
                return Some(i)
            }
            _ => search = i + open.len(),
        }
    }
}

/// Truncate to at most `max` chars on a char boundary.
fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    match s.char_indices().nth(max) {
        Some((idx, _)) => (s[..idx].to_string(), true),
        None => (s.to_string(), false),
    }
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
    #[cfg(target_os = "windows")]
    {
        let mut cmd = if reveal {
            let mut c = std::process::Command::new("explorer");
            // /select wants the verb and path in one comma-joined argument.
            c.arg(format!("/select,{path}"));
            c
        } else {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "start", "", path]);
            c
        };
        cmd.spawn()
            .map_err(|e| format!("failed to open {path}: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(path);
        cmd.spawn().map_err(|e| format!("failed to open {path}: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No universal "reveal" on Linux: open the parent folder instead.
        let target = if reveal {
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
