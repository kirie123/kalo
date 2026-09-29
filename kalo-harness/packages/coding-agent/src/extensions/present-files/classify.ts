/**
 * Pure classification for present_files entries: url vs local file, readable
 * name, absolute-path resolution, dedupe-while-preserving-order, and which
 * entry is primary.
 *
 * Kept free of fs so the ordering/naming/dedupe rules are unit-testable without
 * a filesystem. The `execute` wiring in index.ts does the stat pass (size,
 * existence) on top of what this returns.
 *
 * Design: doc/2026-09-28-产物呈现通道.md
 */

import { isAbsolute, resolve } from "node:path";
import { type ArtifactFileKind, artifactFileKind } from "./file-kind.ts";

export interface ClassifiedArtifact {
	kind: "file" | "url";
	/** Absolute path (file) or the original URL (url). Also the dedupe key. */
	path: string;
	/** File name (file) or "host + last path segment" (url), for display. */
	name: string;
	/** Only for files: render bucket derived from the extension. */
	fileKind?: ArtifactFileKind;
	/** True for files[0] after dedupe. */
	primary: boolean;
}

/** http/https only. Other schemes (file:, ftp:, data:) are treated as local paths or rejected upstream. */
function isHttpUrl(raw: string): boolean {
	return /^https?:\/\//i.test(raw);
}

/** Last non-empty path segment of a url, or the host when the path is empty. */
function urlName(raw: string): string {
	try {
		const u = new URL(raw);
		const segs = u.pathname.split("/").filter((s) => s.length > 0);
		const last = segs[segs.length - 1];
		return last !== undefined ? decodeURIComponent(last) : u.host;
	} catch {
		return raw;
	}
}

/** File name (basename) from an absolute or relative path, accepting both separators. */
function fileName(path: string): string {
	const norm = path.replace(/\\/g, "/");
	const segs = norm.split("/").filter((s) => s.length > 0);
	return segs[segs.length - 1] ?? path;
}

/**
 * Classify one raw entry against the session cwd. Relative file paths resolve
 * to absolute; urls pass through unchanged.
 */
export function classifyOne(raw: string, cwd: string): Omit<ClassifiedArtifact, "primary"> {
	const trimmed = raw.trim();
	if (isHttpUrl(trimmed)) {
		return { kind: "url", path: trimmed, name: urlName(trimmed) };
	}
	const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	return { kind: "file", path: abs, name: fileName(abs), fileKind: artifactFileKind(abs) };
}

/**
 * Classify a raw list: resolve, dedupe by path (first occurrence wins, order
 * preserved), and mark the first as primary. Empty entries are dropped.
 */
export function classify(files: string[], cwd: string): ClassifiedArtifact[] {
	const seen = new Set<string>();
	const out: ClassifiedArtifact[] = [];
	for (const raw of files) {
		if (raw.trim().length === 0) continue;
		const item = classifyOne(raw, cwd);
		if (seen.has(item.path)) continue;
		seen.add(item.path);
		out.push({ ...item, primary: false });
	}
	if (out[0]) out[0].primary = true;
	return out;
}
