import { readFile as fsReadFile, stat as fsStat, readdir } from "node:fs/promises";
import { type AgentTool, globToRegExp, grepFiles, type SearchFs } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/** One directory entry reported by {@link GrepOperations.listDir}. */
export interface GrepDirEntry {
	name: string;
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
	/** List direct children of a directory. Throws if path is not a directory. */
	listDir: (absolutePath: string) => Promise<GrepDirEntry[]> | GrepDirEntry[];
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
	listDir: async (p) => {
		const dirents = await readdir(p, { withFileTypes: true });
		return Promise.all(
			dirents.map(async (dirent) => {
				const kind: GrepDirEntry["kind"] = dirent.isSymbolicLink()
					? "symlink"
					: dirent.isDirectory()
						? "directory"
						: "file";
				if (kind === "symlink") return { name: dirent.name, kind, size: 0, mtimeMs: 0 };
				const info = await fsStat(path.join(p, dirent.name));
				return { name: dirent.name, kind, size: info.size, mtimeMs: info.mtimeMs };
			}),
		);
	},
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem. */
	operations?: GrepOperations;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reject a `glob` filter that is not ONE positive glob: blank strings, negated
 * patterns, and comma-separated lists (braces `{a,b}` are fine — that is one glob).
 */
function validateGlobFilter(glob: string | undefined): void {
	if (glob === undefined) return;
	if (glob.trim().length === 0) throw new Error("glob must be a non-empty string when given");
	if (glob.startsWith("!"))
		throw new Error('glob must be a positive filter; negated patterns ("!...") are not supported');
	let braceDepth = 0;
	for (const char of glob) {
		if (char === "{") braceDepth++;
		else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
		else if (char === "," && braceDepth === 0) {
			throw new Error("glob must be one pattern, not a comma-separated list (use {a,b} alternation instead)");
		}
	}
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with line numbers, grouped by file. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) {
			if (pattern.length === 0) throw new Error("pattern must be a non-empty string");
			validateGlobFilter(glob);
			if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
				throw new Error("limit must be a positive number");
			}

			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const contextValue = context && context > 0 ? Math.floor(context) : 0;
			const flags = ignoreCase === true ? "i" : "";
			const source = literal === true ? escapeRegExp(pattern) : pattern;
			let regex: RegExp;
			try {
				regex = new RegExp(source, flags);
			} catch (error) {
				throw new Error(`Invalid regular expression: ${(error as Error).message}`);
			}
			if (glob !== undefined) globToRegExp(glob);

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const ops = customOps ?? defaultGrepOperations;
			try {
				await ops.isDirectory(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const searchFs: SearchFs = {
				listDir: async (dirPath) => {
					const entries = await ops.listDir(dirPath);
					return entries.map((entry) => ({
						name: entry.name,
						path: path.join(dirPath, entry.name),
						kind: entry.kind,
						size: entry.size,
						mtimeMs: entry.mtimeMs,
					}));
				},
				readTextFile: async (filePath) => ops.readFile(filePath),
			};

			const result = await grepFiles(searchFs, {
				pattern: regex,
				root: searchPath,
				glob,
				maxMatches: effectiveLimit,
				signal,
			});

			if (result.matchCount === 0) {
				const suffix = result.filesSearched > 0 ? ` (searched ${result.filesSearched} files)` : "";
				return { content: [{ type: "text", text: `No matches found${suffix}` }], details: undefined };
			}

			// Expand context blocks from file contents, then render grouped output.
			const fileCache = new Map<string, string[]>();
			const getFileLines = async (absolutePath: string): Promise<string[]> => {
				let lines = fileCache.get(absolutePath);
				if (!lines) {
					try {
						const content = await ops.readFile(absolutePath);
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(absolutePath, lines);
				}
				return lines;
			};

			const sections: string[] = [];
			let linesTruncated = false;
			for (const file of result.files) {
				const rows: string[] = [];
				if (contextValue === 0) {
					for (const match of file.matches) {
						const { text, wasTruncated } = truncateLine(match.line);
						linesTruncated ||= wasTruncated;
						rows.push(`Line ${match.lineNumber}: ${text}`);
					}
				} else {
					const lines = await getFileLines(file.absolutePath);
					for (const match of file.matches) {
						if (!rows.includes(`Line ${match.lineNumber}:`)) {
							const start = Math.max(1, match.lineNumber - contextValue);
							const end = Math.min(lines.length, match.lineNumber + contextValue);
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const { text, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
								linesTruncated ||= wasTruncated;
								rows.push(
									current === match.lineNumber ? `Line ${current}: ${text}` : `Line ${current}- ${text}`,
								);
							}
						}
					}
				}
				sections.push(`${file.displayPath}\n${rows.join("\n")}`);
			}

			const header = result.matchLimitReached
				? `Found ${result.matchCount} matches (limit ${effectiveLimit} reached)`
				: `Found ${result.matchCount} ${result.matchCount === 1 ? "match" : "matches"}`;
			const rawOutput = `${header}\n\n${sections.join("\n\n")}`;
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails = {};
			const notices: string[] = [];
			if (result.matchLimitReached) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (result.walkTruncated) {
				notices.push("Directory walk hit its entry budget; narrow path for full coverage");
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
