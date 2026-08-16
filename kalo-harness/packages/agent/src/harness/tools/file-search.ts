import type { Ignore } from "ignore";
import ignore from "ignore";
import type { FileInfo } from "../types.ts";

/**
 * Minimal filesystem primitives shared by the grep and glob tools. `ExecutionEnv`
 * satisfies this via thin adapters; other embedders can adapt their own backend.
 * Methods reject on failure (adapters unwrap the `Result` wrappers).
 */
export interface SearchFs {
	/** List direct children of a directory without following symlinks. Rejects when not a directory. */
	listDir(path: string, signal?: AbortSignal): Promise<FileInfo[]>;
	/** Read a UTF-8 text file. Rejects on missing/binary-incompatible files. */
	readTextFile(path: string, signal?: AbortSignal): Promise<string>;
}

/** One file discovered by {@link walkFiles}. */
export interface WalkEntry {
	/** Path relative to the walk root, posix separators. */
	path: string;
	/** Absolute path in the underlying filesystem namespace. */
	absolutePath: string;
	/** File size in bytes. */
	size: number;
	/** Modification time in milliseconds since the Unix epoch. */
	mtimeMs: number;
}

/** Result of one {@link walkFiles} call. */
export interface WalkResult {
	/** Discovered files in depth-first name order. */
	entries: WalkEntry[];
	/** Whether the walk stopped early at the entry budget. */
	truncated: boolean;
}

/** Options for {@link walkFiles}. */
export interface WalkOptions {
	/** Abort signal checked between filesystem calls. */
	signal?: AbortSignal;
	/** Maximum directory entries to visit before stopping early. Default: 20000. */
	maxEntries?: number;
}

/** Directory names the walker never descends into. */
export const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".cache",
	"__pycache__",
	".venv",
]);

/** Default walk budget: maximum directory entries visited per call. */
export const MAX_WALK_ENTRIES = 20000;

/** Files larger than this are skipped by content search. */
export const DEFAULT_MAX_FILE_BYTES = 1.5 * 1024 * 1024;

function basename(path: string): string {
	const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

function escapeRegExp(char: string): string {
	return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the index of the closing `}` balancing the `{` at `openIndex`, or -1. */
function findBalancedBrace(pattern: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < pattern.length; i++) {
		if (pattern[i] === "{") depth++;
		else if (pattern[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Split `text` on top-level commas (commas inside `{}` groups stay). */
function splitTopLevelAlternatives(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "{") depth++;
		else if (char === "}") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** Compile the inside of a glob pattern into a regex source fragment. */
function compileGlobBody(pattern: string): string {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					out += "(?:[^/]+/)*";
					i += 3;
				} else {
					out += ".*";
					i += 2;
				}
			} else {
				out += "[^/]*";
				i += 1;
			}
		} else if (char === "?") {
			out += "[^/]";
			i += 1;
		} else if (char === "{") {
			const close = findBalancedBrace(pattern, i);
			if (close === -1) {
				out += escapeRegExp(char);
				i += 1;
			} else {
				const branches = splitTopLevelAlternatives(pattern.slice(i + 1, close));
				out += `(?:${branches.map((branch) => compileGlobBody(branch)).join("|")})`;
				i = close + 1;
			}
		} else if (char === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close === -1) {
				out += escapeRegExp(char);
				i += 1;
			} else {
				out += pattern.slice(i, close + 1);
				i = close + 1;
			}
		} else {
			out += escapeRegExp(char);
			i += 1;
		}
	}
	return out;
}

/**
 * Compile a glob pattern into a RegExp tested against posix-style relative paths.
 *
 * Semantics: `**` crosses directory separators, `*`/`?` stay within one segment,
 * `{a,b}` alternates, `[...]` character classes pass through. A pattern without
 * `/` matches the basename at any depth (`*.ts` matches `src/a.ts`); a pattern
 * with `/` anchors against the path relative to the search root.
 */
export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, "/");
	if (normalized.trim().length === 0) throw new Error("glob pattern must be a non-empty string");
	const anchored = `^${compileGlobBody(normalized)}$`;
	if (normalized.includes("/")) return new RegExp(anchored);
	return new RegExp(`^(?:[^/]+/)*${compileGlobBody(normalized)}$`);
}

interface IgnoreLayer {
	/** Path of the directory owning the .gitignore, relative to the walk root ("" for root). */
	base: string;
	matcher: Ignore;
}

function isIgnoredByLayers(layers: readonly IgnoreLayer[], relativePath: string): boolean {
	for (const layer of layers) {
		const pathFromBase = layer.base === "" ? relativePath : relativePath.slice(layer.base.length + 1);
		if (layer.matcher.ignores(pathFromBase)) return true;
	}
	return false;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

/**
 * Walk `root` depth-first and collect files (never directories), honoring
 * nested `.gitignore` files, skipping hidden entries, symlinked directories,
 * and {@link DEFAULT_EXCLUDED_DIRS}. Stops early at the entry budget.
 */
export async function walkFiles(fs: SearchFs, root: string, options: WalkOptions = {}): Promise<WalkResult> {
	const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES;
	const entries: WalkEntry[] = [];
	const stack: Array<{ absolutePath: string; relativePath: string; layers: IgnoreLayer[] }> = [
		{ absolutePath: root, relativePath: "", layers: [] },
	];
	let visited = 0;
	let truncated = false;

	while (stack.length > 0) {
		throwIfAborted(options.signal);
		const frame = stack.pop();
		if (frame === undefined) break;
		let children: FileInfo[];
		try {
			children = await fs.listDir(frame.absolutePath, options.signal);
		} catch {
			continue;
		}
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

		let layers = frame.layers;
		try {
			const gitignore = await fs.readTextFile(`${frame.absolutePath}/.gitignore`, options.signal);
			layers = [...layers, { base: frame.relativePath, matcher: ignore().add(gitignore) }];
		} catch {
			// No (or unreadable) .gitignore in this directory; inherit parent layers only.
		}

		for (const child of children) {
			visited += 1;
			if (visited > maxEntries) {
				truncated = true;
				break;
			}
			if (child.name.startsWith(".")) continue;
			if (child.kind === "symlink") continue;
			const childRelativePath = frame.relativePath === "" ? child.name : `${frame.relativePath}/${child.name}`;
			if (isIgnoredByLayers(layers, childRelativePath)) continue;
			if (child.kind === "directory") {
				if (DEFAULT_EXCLUDED_DIRS.has(child.name)) continue;
				stack.push({ absolutePath: child.path, relativePath: childRelativePath, layers });
			} else {
				entries.push({
					path: childRelativePath,
					absolutePath: child.path,
					size: child.size,
					mtimeMs: child.mtimeMs,
				});
			}
		}
		if (truncated) break;
	}
	return { entries, truncated };
}

/** One matched line inside one file. */
export interface GrepLineMatch {
	/** 1-indexed line number within the file. */
	lineNumber: number;
	/** Matched line text with the trailing newline removed. */
	line: string;
}

/** Matches for one file, in line-number order. */
export interface GrepFileMatches {
	/** Display path: relative to the search root (posix separators), or the file's basename for a single-file search. */
	displayPath: string;
	/** Absolute path in the underlying filesystem namespace. */
	absolutePath: string;
	matches: GrepLineMatch[];
}

/** Result of one {@link grepFiles} call. */
export interface GrepFilesResult {
	/** Files with at least one match, in walk order. */
	files: GrepFileMatches[];
	/** Total matched lines across all files. */
	matchCount: number;
	/** Files whose contents were searched. */
	filesSearched: number;
	/** Files skipped due to size or binary detection. */
	filesSkipped: number;
	/** Whether the walk stopped early at the entry budget. */
	walkTruncated: boolean;
	/** Whether matching stopped early at the match budget. */
	matchLimitReached: boolean;
}

/** Options for {@link grepFiles}. */
export interface GrepFilesOptions {
	/** Precompiled pattern tested against each line. */
	pattern: RegExp;
	/** Absolute file or directory to search. */
	root: string;
	/** Optional glob filter on paths relative to the root (or basenames for patterns without `/`). */
	glob?: string;
	/** Files larger than this many bytes are skipped. Default: {@link DEFAULT_MAX_FILE_BYTES}. */
	maxFileBytes?: number;
	/** Stop searching after this many matched lines. No limit when undefined. */
	maxMatches?: number;
	signal?: AbortSignal;
}

/** Heuristic binary detection: a NUL byte in the leading window means skip. */
function looksBinary(content: string): boolean {
	return content.slice(0, 8192).includes("\u0000");
}

function grepContent(content: string, pattern: RegExp, maxMatches?: number): GrepLineMatch[] {
	const matches: GrepLineMatch[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		if (maxMatches !== undefined && matches.length >= maxMatches) break;
		const line = lines[index];
		if (line.endsWith("\r") ? pattern.test(line.slice(0, -1)) : pattern.test(line)) {
			matches.push({ lineNumber: index + 1, line: line.replace(/\r$/, "") });
		}
	}
	return matches;
}

/**
 * Search file contents under `root`. A directory root walks with
 * {@link walkFiles} (ignore rules apply) and applies the optional glob filter;
 * a file root searches that single file directly, bypassing ignore rules.
 */
export async function grepFiles(fs: SearchFs, options: GrepFilesOptions): Promise<GrepFilesResult> {
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxMatches = options.maxMatches;
	const globFilter = options.glob === undefined ? undefined : globToRegExp(options.glob);
	const result: GrepFilesResult = {
		files: [],
		matchCount: 0,
		filesSearched: 0,
		filesSkipped: 0,
		walkTruncated: false,
		matchLimitReached: false,
	};

	const recordFile = (displayPath: string, absolutePath: string, matches: GrepLineMatch[]): void => {
		if (matches.length === 0) return;
		result.files.push({ displayPath, absolutePath, matches });
		result.matchCount += matches.length;
	};

	let isDirectory: boolean;
	try {
		await fs.listDir(options.root, options.signal);
		isDirectory = true;
	} catch {
		isDirectory = false;
	}

	if (!isDirectory) {
		// Single-file search: ignore rules do not apply to an explicit file path.
		let content: string;
		try {
			content = await fs.readTextFile(options.root, options.signal);
		} catch (error) {
			throw new Error(`Path not found or unreadable: ${options.root}`, { cause: error });
		}
		const matches = looksBinary(content)
			? []
			: maxMatches === undefined
				? grepContent(content, options.pattern)
				: grepContent(content, options.pattern).slice(0, maxMatches);
		result.filesSearched = 1;
		recordFile(basename(options.root), options.root, matches);
		result.matchLimitReached = maxMatches !== undefined && result.matchCount >= maxMatches;
		return result;
	}

	const walk = await walkFiles(fs, options.root, { signal: options.signal });
	result.walkTruncated = walk.truncated;
	for (const entry of walk.entries) {
		throwIfAborted(options.signal);
		if (globFilter !== undefined && !globFilter.test(entry.path)) continue;
		if (maxMatches !== undefined && result.matchCount >= maxMatches) break;
		if (entry.size > maxFileBytes) {
			result.filesSkipped += 1;
			continue;
		}
		let content: string;
		try {
			content = await fs.readTextFile(entry.absolutePath, options.signal);
		} catch {
			result.filesSkipped += 1;
			continue;
		}
		if (looksBinary(content)) {
			result.filesSkipped += 1;
			continue;
		}
		result.filesSearched += 1;
		const remaining = maxMatches === undefined ? undefined : Math.max(0, maxMatches - result.matchCount);
		const matches = grepContent(content, options.pattern, remaining);
		recordFile(entry.path, entry.absolutePath, matches);
	}
	result.matchLimitReached = maxMatches !== undefined && result.matchCount >= maxMatches;
	return result;
}
