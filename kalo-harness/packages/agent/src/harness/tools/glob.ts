import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { globToRegExp, type SearchFs, walkFiles } from "./file-search.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const GLOB_DEFAULT_LIMIT = 100;

const globSchema = Type.Object({
	pattern: Type.String({
		description:
			'Glob pattern to match file paths (e.g. "**/*.ts", "src/**/*.test.js"). A pattern without "/" matches basenames at any depth, so "*.ts" matches every .ts file in the tree',
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current working directory)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum paths to return (default: ${GLOB_DEFAULT_LIMIT})` })),
});

export type GlobToolInput = Static<typeof globSchema>;

export interface GlobToolDetails {
	resultLimitReached?: number;
	walkTruncated: boolean;
}

export function createGlobTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof globSchema,
	GlobToolDetails
> {
	return {
		name: "glob",
		label: "glob",
		description: `Find files whose paths match a glob pattern. Returns file paths (never directories) relative to the search path, newest first. Respects .gitignore and skips dependency/build directories. Up to ${GLOB_DEFAULT_LIMIT} paths are returned; a capped result says so.`,
		parameters: globSchema,
		async execute(_toolCallId, args, signal, _onUpdate, { env }) {
			if (args.pattern.trim().length === 0) throw new Error("pattern must be a non-empty string");
			if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit <= 0)) {
				throw new Error("limit must be a positive number");
			}
			const limit = args.limit ?? GLOB_DEFAULT_LIMIT;
			const filter = globToRegExp(args.pattern);

			const searchRoot = await resolveToolPath(env, args.path ?? ".", signal);
			const fs: SearchFs = {
				listDir: async (path, abortSignal) => getOrThrow(await env.listDir(path, abortSignal)),
				readTextFile: async (path, abortSignal) => getOrThrow(await env.readTextFile(path, abortSignal)),
			};
			try {
				await fs.listDir(searchRoot, signal);
			} catch {
				throw new Error(`Directory not found: ${searchRoot}`);
			}

			const walk = await walkFiles(fs, searchRoot, { signal });
			const matching = walk.entries.filter((entry) => filter.test(entry.path));
			if (matching.length === 0) {
				return {
					content: [{ type: "text", text: `No files found matching pattern '${args.pattern}'` }],
					details: { walkTruncated: walk.truncated },
				};
			}

			matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
			const capped = matching.length > limit;
			const shown = capped ? matching.slice(0, limit) : matching;
			let output = shown.map((entry) => entry.path).join("\n");
			if (capped) {
				output += `\n\n(Showing ${limit} of ${matching.length} matching files, newest first. Use a narrower pattern or path to reduce results.)`;
			}
			if (walk.truncated && !capped) {
				output += `\n\n[Directory walk hit its entry budget; results may be incomplete. Narrow path for full coverage.]`;
			}
			return {
				content: [{ type: "text", text: output }],
				details: {
					...(capped ? { resultLimitReached: limit } : {}),
					walkTruncated: walk.truncated,
				},
			};
		},
	};
}
