import { readFile as fsReadFile, stat as fsStat, readdir } from "node:fs/promises";
import { type AgentTool, globToRegExp, type SearchFs, walkFiles } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const globSchema = Type.Object({
	pattern: Type.String({
		description:
			'Glob pattern to match file paths (e.g. "**/*.ts", "src/**/*.test.js"). A pattern without "/" matches basenames at any depth, so "*.ts" matches every .ts file in the tree',
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of paths to return (default: 100)" })),
});

export const globToolSystemPromptContribution = {
	snippet: "Find files by glob pattern, newest first (respects .gitignore)",
	guidelines: [],
} as const;

export type GlobToolInput = Static<typeof globSchema>;

const DEFAULT_LIMIT = 100;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	walkTruncated?: boolean;
}

/** One directory entry reported by {@link GlobOperations.listDir}. */
export interface GlobDirEntry {
	name: string;
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
}

/**
 * Pluggable operations for the glob tool.
 * Override these to delegate file discovery to remote systems (for example SSH).
 */
export interface GlobOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents (used for .gitignore rules). */
	readFile: (absolutePath: string) => Promise<string> | string;
	/** List direct children of a directory. Throws if path is not a directory. */
	listDir: (absolutePath: string) => Promise<GlobDirEntry[]> | GlobDirEntry[];
}

const defaultGlobOperations: GlobOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
	listDir: async (p) => {
		const dirents = await readdir(p, { withFileTypes: true });
		return Promise.all(
			dirents.map(async (dirent) => {
				const kind: GlobDirEntry["kind"] = dirent.isSymbolicLink()
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

export interface GlobToolOptions {
	/** Custom operations for glob. Default: local filesystem. */
	operations?: GlobOperations;
}

function formatGlobCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("glob")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatGlobResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GlobToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGlobToolDefinition(
	cwd: string,
	options?: GlobToolOptions,
): ToolDefinition<typeof globSchema, GlobToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "glob",
		label: "glob",
		description: `Find files whose paths match a glob pattern. Returns file paths (never directories) relative to the search directory, newest first. A pattern without "/" matches basenames at any depth. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: globToolSystemPromptContribution.snippet,
		parameters: globSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
		) {
			if (pattern.length === 0) throw new Error("pattern must be a non-empty string");
			if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
				throw new Error("limit must be a positive number");
			}
			const effectiveLimit = limit ?? DEFAULT_LIMIT;
			const filter = globToRegExp(pattern);

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const ops = customOps ?? defaultGlobOperations;
			let isDirectory: boolean;
			try {
				isDirectory = await ops.isDirectory(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}
			if (!isDirectory) throw new Error(`Not a directory: ${searchPath}`);

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

			const walk = await walkFiles(searchFs, searchPath, { signal });
			const matching = walk.entries.filter((entry) => filter.test(entry.path));
			if (matching.length === 0) {
				return {
					content: [{ type: "text", text: `No files found matching pattern '${pattern}'` }],
					details: walk.truncated ? { walkTruncated: true } : undefined,
				};
			}

			matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
			const capped = matching.length > effectiveLimit;
			const shown = capped ? matching.slice(0, effectiveLimit) : matching;
			const rawOutput = shown.map((entry) => entry.path).join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GlobToolDetails = {};
			const notices: string[] = [];
			if (capped) {
				notices.push(
					`Showing ${effectiveLimit} of ${matching.length} matching files, newest first. Use a narrower pattern or path to reduce results`,
				);
				details.resultLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (walk.truncated) {
				notices.push(
					"Directory walk hit its entry budget; results may be incomplete. Narrow path for full coverage",
				);
				details.walkTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGlobCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGlobResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGlobTool(cwd: string, options?: GlobToolOptions): AgentTool<typeof globSchema> {
	return wrapToolDefinition(createGlobToolDefinition(cwd, options));
}
