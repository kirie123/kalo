import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead, truncateLine } from "../utils/truncate.ts";
import { type GrepFilesResult, grepFiles, type SearchFs } from "./file-search.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const GREP_DEFAULT_LIMIT = 200;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regular expression to search for (JavaScript regex syntax)" }),
	path: Type.Optional(
		Type.String({ description: "File or directory to search (default: current working directory)" }),
	),
	glob: Type.Optional(
		Type.String({
			description: 'Single positive glob filter for which files to search, e.g. "*.ts" or "*.{js,jsx}"',
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default: ${GREP_DEFAULT_LIMIT})` })),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	matchLimitReached?: number;
	linesTruncated?: boolean;
	truncation?: TruncationResult;
	filesSearched: number;
	walkTruncated: boolean;
}

/**
 * Reject a `glob` filter that is not ONE positive glob: blank strings, negated
 * patterns, and comma-separated lists (braces `{a,b}` are fine — that is one glob).
 */
function validateGlobFilter(glob: string): void {
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

/** Group matches per file into the model-facing body: display path, then `Line N: text` rows. */
function formatGrepBody(result: GrepFilesResult): { body: string; linesTruncated: boolean } {
	const sections: string[] = [];
	let linesTruncated = false;
	for (const file of result.files) {
		const rows: string[] = [];
		for (const match of file.matches) {
			const { text, wasTruncated } = truncateLine(match.line);
			linesTruncated ||= wasTruncated;
			rows.push(`Line ${match.lineNumber}: ${text}`);
		}
		sections.push(`${file.displayPath}\n${rows.join("\n")}`);
	}
	return { body: sections.join("\n\n"), linesTruncated };
}

export function createGrepTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof grepSchema,
	GrepToolDetails
> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents with a regular expression. Returns matching lines with line numbers, grouped by file. Respects .gitignore and skips dependency/build directories and binary files. Output is capped at ${GREP_DEFAULT_LIMIT} matches (raise with limit) and ${DEFAULT_MAX_BYTES / 1024}KB. Use read on a matched file for surrounding context.`,
		parameters: grepSchema,
		async execute(_toolCallId, args, signal, _onUpdate, { env }) {
			if (args.pattern.length === 0) throw new Error("pattern must be a non-empty string");
			if (args.glob !== undefined) validateGlobFilter(args.glob);
			if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit <= 0)) {
				throw new Error("limit must be a positive number");
			}
			let pattern: RegExp;
			try {
				pattern = new RegExp(args.pattern, args.ignoreCase === true ? "i" : undefined);
			} catch (error) {
				throw new Error(`Invalid regular expression: ${(error as Error).message}`);
			}
			const limit = args.limit ?? GREP_DEFAULT_LIMIT;

			const searchRoot = await resolveToolPath(env, args.path ?? ".", signal);
			const fs: SearchFs = {
				listDir: async (path, abortSignal) => getOrThrow(await env.listDir(path, abortSignal)),
				readTextFile: async (path, abortSignal) => getOrThrow(await env.readTextFile(path, abortSignal)),
			};
			const result = await grepFiles(fs, {
				pattern,
				root: searchRoot,
				glob: args.glob,
				maxMatches: limit,
				signal,
			});

			if (result.matchCount === 0) {
				const suffix = result.filesSearched > 0 ? ` (searched ${result.filesSearched} files)` : "";
				return {
					content: [{ type: "text", text: `No matches found${suffix}` }],
					details: {
						filesSearched: result.filesSearched,
						walkTruncated: result.walkTruncated,
					},
				};
			}

			const { body, linesTruncated } = formatGrepBody(result);
			const header = result.matchLimitReached
				? `Found ${result.matchCount} matches (limit ${limit} reached)`
				: `Found ${result.matchCount} ${result.matchCount === 1 ? "match" : "matches"}`;

			const notices: string[] = [];
			if (result.matchLimitReached) {
				notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern/path`);
			}
			if (result.walkTruncated) notices.push("Directory walk hit its entry budget; narrow path for full coverage");
			if (linesTruncated) notices.push("Some lines truncated. Use read to see full lines");

			const truncation = truncateHead(`${header}\n\n${body}`);
			let output = truncation.content;
			const details: GrepToolDetails = {
				filesSearched: result.filesSearched,
				walkTruncated: result.walkTruncated,
			};
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`);
				details.truncation = truncation;
			}
			if (result.matchLimitReached) details.matchLimitReached = limit;
			if (linesTruncated) details.linesTruncated = true;
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return { content: [{ type: "text", text: output }], details };
		},
	};
}
