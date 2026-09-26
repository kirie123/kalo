/**
 * Tracks which files the agent has actually read in the current session, so the
 * edit tool can refuse to modify a file the model has not seen (or has not seen
 * since it last changed on disk). This mirrors Claude Code's "read before edit"
 * guard and prevents the common failure where a model reconstructs `oldText`
 * from a grep/tail fragment (or a post-compaction memory) that no longer matches
 * the real bytes.
 *
 * The signature is derived from the file *content* the read/write/edit tools
 * already hold in memory, not from filesystem mtime. This keeps the guard
 * backend-agnostic (custom operations need not expose stat) and immune to
 * coarse/jittery mtime resolution on Windows.
 */

/** Normalize an absolute path for use as a map key (Windows-safe). */
function normalizeKey(absolutePath: string): string {
	let key = absolutePath.split("\\").join("/");
	// Lowercase a leading drive letter so "D:/x" and "d:/x" collide.
	if (/^[a-zA-Z]:\//.test(key)) {
		key = key[0].toLowerCase() + key.slice(1);
	}
	return key;
}

/**
 * Compute a cheap, stable signature string for a file's UTF-8 content. Uses
 * FNV-1a over the string plus the length, so different-length edits never
 * collide. Format: "<length>:<hash>".
 */
export function signatureOf(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		// FNV prime multiply, kept in 32-bit range.
		hash = Math.imul(hash, 0x01000193);
	}
	return `${content.length}:${(hash >>> 0).toString(16)}`;
}

export class FileReadState {
	private readonly signatures = new Map<string, string>();

	/** Record the content the tool just read from (or wrote to) a file. */
	record(absolutePath: string, content: string): void {
		this.signatures.set(normalizeKey(absolutePath), signatureOf(content));
	}

	/** The recorded content signature, or undefined when never read this session. */
	get(absolutePath: string): string | undefined {
		return this.signatures.get(normalizeKey(absolutePath));
	}

	/** True when the file has been read/written in this session. */
	has(absolutePath: string): boolean {
		return this.signatures.has(normalizeKey(absolutePath));
	}

	clear(): void {
		this.signatures.clear();
	}
}
