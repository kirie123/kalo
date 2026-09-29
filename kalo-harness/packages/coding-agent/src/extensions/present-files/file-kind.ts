/**
 * How the desktop client should render a presented file, decided from its
 * extension alone.
 *
 * This is an engine-side mirror of `kalo-desktop/src/lib/file-kind.ts`: the two
 * tables must agree on which extensions are "html" (sandbox preview) vs other
 * kinds, or the auto-open decision on the client would disagree with what the
 * card shows. Kept deliberately small — present_files only needs the render
 * bucket, not the highlight.js language ids the frontend also derives.
 *
 * Design: doc/2026-09-28-产物呈现通道.md
 */

export type ArtifactFileKind = "markdown" | "html" | "svg" | "text" | "image" | "docx" | "xlsx" | "pdf" | "opaque";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);
const HTML_EXTS = new Set(["html", "htm", "xhtml"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const OPAQUE_EXTS = new Set([
	"doc",
	"xls",
	"ppt",
	"pptx",
	"rtf",
	"odt",
	"ods",
	"odp",
	"zip",
	"rar",
	"7z",
	"gz",
	"tar",
	"tgz",
	"bz2",
	"xz",
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	"dat",
	"class",
	"pyc",
	"wasm",
	"mp3",
	"wav",
	"flac",
	"ogg",
	"m4a",
	"aac",
	"mp4",
	"mov",
	"avi",
	"mkv",
	"webm",
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	"db",
	"sqlite",
	"sqlite3",
	"pdb",
]);

/** Lowercase extension without the dot; empty when the name has none. Accepts both separators. */
export function extensionOf(path: string): string {
	const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
	const i = name.lastIndexOf(".");
	if (i <= 0) return "";
	return name.slice(i + 1).toLowerCase();
}

export function artifactFileKind(path: string): ArtifactFileKind {
	const ext = extensionOf(path);
	if (MARKDOWN_EXTS.has(ext)) return "markdown";
	if (HTML_EXTS.has(ext)) return "html";
	if (ext === "svg") return "svg";
	if (IMAGE_EXTS.has(ext)) return "image";
	if (ext === "docx" || ext === "docm") return "docx";
	if (ext === "xlsx" || ext === "xlsm") return "xlsx";
	if (ext === "pdf") return "pdf";
	if (OPAQUE_EXTS.has(ext)) return "opaque";
	return "text";
}
