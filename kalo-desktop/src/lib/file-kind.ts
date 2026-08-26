/**
 * How the preview should render a path, decided from its extension alone.
 *
 * Extension-only on purpose: the preview has to pick a loader (text vs bytes)
 * *before* reading anything, and sniffing content would mean two round trips
 * for every file. `read_file_text` still has the last word on whether a
 * "text" file is actually binary.
 */

export type FileKind =
  /** Rendered as markdown, with a source toggle. */
  | "markdown"
  /** Plain monospace text. */
  | "text"
  /** `<img>` from a data URL. */
  | "image"
  /** Word (OOXML), unpacked in the frontend. */
  | "docx"
  /** Excel (OOXML), unpacked in the frontend. */
  | "xlsx"
  /** Handed to the webview's own PDF viewer. */
  | "pdf"
  /** Known format we cannot render: offer "open externally" instead. */
  | "opaque";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/**
 * Formats with no viable in-app rendering. Legacy Office (`doc`/`xls`/`ppt`)
 * is here rather than under docx/xlsx: those are OLE compound files, not zips,
 * and nothing in the OOXML path can read them.
 */
const OPAQUE_EXTS = new Set([
  "doc", "xls", "ppt", "pptx", "rtf", "odt", "ods", "odp",
  "zip", "rar", "7z", "gz", "tar", "tgz", "bz2", "xz",
  "exe", "dll", "so", "dylib", "bin", "dat", "class", "pyc", "wasm",
  "mp3", "wav", "flac", "ogg", "m4a", "aac",
  "mp4", "mov", "avi", "mkv", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "pdb",
]);

/** Lowercase extension without the dot; empty when the name has none. */
export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = name.lastIndexOf(".");
  // A leading dot is the whole name (".gitignore"), not an extension.
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

export function fileKind(path: string): FileKind {
  const ext = extensionOf(path);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "docx" || ext === "docm") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "pdf") return "pdf";
  if (OPAQUE_EXTS.has(ext)) return "opaque";
  // SVG is text first: source is more useful than a render in a code tool,
  // and it lands here rather than in IMAGE_EXTS for that reason.
  return "text";
}

/** True when the kind is loaded through `read_file_bytes` rather than as text. */
export function needsBytes(kind: FileKind): boolean {
  return kind === "image" || kind === "docx" || kind === "xlsx" || kind === "pdf";
}

/** Human-readable byte size for the "too large" / opaque-file notices. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
