import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, normalizeToLF } from "../src/core/tools/edit-diff.ts";
import { describeClosestMatch, formatClosestMatchDiagnostic } from "../src/core/tools/edit-diff-diagnostics.ts";

/**
 * Real failure sample (cowith session, 2026-09-17, router_agent.py): the model
 * rebuilt `oldText` with a stray `n` right after the Chinese full stop, while
 * the file contains `...不进 openapi。` (CRLF).
 */
const ROUTER_FILE_LINES = [
	'"""内部 Agent 数据访问接口（PR-33 第 2 步交付）。',
	"",
	"挂在 /internal/rooms/{room_id}/... 下，不进 openapi。",
	"Agent 典型调用顺序：",
	"  1. GET /internal/rooms/{id}/messages?after=0        # 拉历史消息",
	"  2. GET /internal/rooms/{id}/work-items              # 拉当前任务",
];

function routerFileContent(ending = "\n"): string {
	return ROUTER_FILE_LINES.join(ending) + ending;
}

function captureError(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to throw");
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-diagnostics-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("describeClosestMatch", () => {
	it("locates the real drift sample and names the extra trailing character", () => {
		const oldText = [
			"挂在 /internal/rooms/{room_id}/... 下，不进 openapi。n",
			"Agent 典型调用顺序：",
			"  1. GET /internal/rooms/{id}/messages?after=0        # 拉历史消息",
		].join("\n");

		const diagnostic = describeClosestMatch(routerFileContent(), oldText);

		expect(diagnostic).toBeDefined();
		expect(diagnostic?.startLine).toBe(3);
		expect(diagnostic?.endLine).toBe(5);
		expect(diagnostic?.oldTextLines).toBe(3);
		expect(diagnostic?.similarity).toBeGreaterThan(0.9);
		expect(diagnostic?.difference?.line).toBe(3);
		expect(diagnostic?.difference?.fileLine).toBe("挂在 /internal/rooms/{room_id}/... 下，不进 openapi。");
		expect(diagnostic?.difference?.oldTextLine).toBe("挂在 /internal/rooms/{room_id}/... 下，不进 openapi。n");
		expect(diagnostic?.difference?.extraInOldText).toBe("n");
		expect(diagnostic?.difference?.extraInFile).toBeUndefined();
	});

	it("flags a missing trailing character on the file side", () => {
		const content = "Alpha line one\nBeta line two\nGamma line three\n";
		const oldText = "Alpha line one\nBeta line tw\nGamma line three";

		const diagnostic = describeClosestMatch(content, oldText);

		expect(diagnostic?.difference?.line).toBe(2);
		expect(diagnostic?.difference?.extraInFile).toBe("o");
		expect(diagnostic?.difference?.extraInOldText).toBeUndefined();
		expect(diagnostic?.similarity).toBeCloseTo((1 + 12 / 13 + 1) / 3, 5);
	});

	it("returns undefined when either side has no lines", () => {
		expect(describeClosestMatch("", "abc")).toBeUndefined();
		expect(describeClosestMatch("abc", "")).toBeUndefined();
		expect(describeClosestMatch("abc\n", "")).toBeUndefined();
	});

	it("reports a missing line at the end of the file", () => {
		const diagnostic = describeClosestMatch("alpha\nbeta\ngamma\n", "beta\ngamma\ndelta");

		expect(diagnostic?.startLine).toBe(2);
		expect(diagnostic?.endLine).toBe(3);
		expect(diagnostic?.difference?.line).toBe(4);
		expect(diagnostic?.difference?.fileLine).toBeUndefined();
		expect(diagnostic?.difference?.oldTextLine).toBe("delta");
		expect(formatClosestMatchDiagnostic(diagnostic!)).toContain("(end of file)");
	});

	it("reports low similarity for unrelated text", () => {
		const diagnostic = describeClosestMatch("completely different content\n", "this does not exist");

		expect(diagnostic).toBeDefined();
		expect(diagnostic?.similarity).toBeLessThan(0.5);
		expect(diagnostic?.difference?.line).toBe(1);
	});
});

describe("edit not-found diagnostics", () => {
	it("keeps the legacy single-edit prefix and appends the diagnosis", () => {
		const oldText = [
			"挂在 /internal/rooms/{room_id}/... 下，不进 openapi。n",
			"Agent 典型调用顺序：",
			"  1. GET /internal/rooms/{id}/messages?after=0        # 拉历史消息",
		].join("\n");

		const error = captureError(() =>
			applyEditsToNormalizedContent(routerFileContent(), [{ oldText, newText: "replacement" }], "router_agent.py"),
		);

		expect(error.message).toContain(
			"Could not find the exact text in router_agent.py. The old text must match exactly including all whitespace and newlines.",
		);
		expect(error.message).toContain("Closest match: lines 3-5");
		expect(error.message).toMatch(/line 3 file\s*: `挂在 \/internal\/rooms\/\{room_id\}\/\.\.\. 下，不进 openapi。`/);
		expect(error.message).toMatch(
			/line 3 oldText\s*: `挂在 \/internal\/rooms\/\{room_id\}\/\.\.\. 下，不进 openapi。n`/,
		);
		expect(error.message).toContain('The oldText line has 1 extra trailing character that is not in the file: "n".');
		expect(error.message).toContain(
			"Re-read the file with the read tool, then retry with text copied verbatim from the file.",
		);
	});

	it("keeps the legacy multi-edit prefix and points at the failing edit", () => {
		const content = "Alpha line one\nBeta line two\nGamma line three\n";
		const error = captureError(() =>
			applyEditsToNormalizedContent(
				content,
				[
					{
						oldText: "Alpha line one",
						newText: "Alpha line 1",
					},
					{
						oldText: "Beta line tw\nGamma line three",
						newText: "Beta line 2\nGamma line three",
					},
				],
				"sample.txt",
			),
		);

		expect(error.message).toContain(
			"Could not find edits[1] in sample.txt. The oldText must match exactly including all whitespace and newlines.",
		);
		expect(error.message).toContain("Closest match: lines 2-3");
		expect(error.message).toContain('The file line has 1 extra trailing character that the oldText is missing: "o".');
	});

	it("falls back to a path check hint when nothing is close", () => {
		const error = captureError(() =>
			applyEditsToNormalizedContent(
				"completely different content\n",
				[{ oldText: "this does not exist", newText: "x" }],
				"other.txt",
			),
		);

		expect(error.message).toContain("Closest match: line 1");
		expect(error.message).toContain(
			"No closely matching region was found. Verify the path and re-read the file before retrying.",
		);
	});

	it("truncates long lines in the diagnosis", () => {
		const error = captureError(() =>
			applyEditsToNormalizedContent(
				`${"x".repeat(300)}\n`,
				[{ oldText: `${"x".repeat(299)}y`, newText: "z" }],
				"long.txt",
			),
		);

		expect(error.message).toContain("…");
		expect(error.message).toContain("x".repeat(96));
		expect(error.message).not.toContain("x".repeat(160));
	});

	it("still applies fuzzy-tolerant edits (trailing whitespace and smart quotes)", () => {
		const trailing = applyEditsToNormalizedContent(
			normalizeToLF("hello world  \n"),
			[{ oldText: "hello world\n", newText: "hi\n" }],
			"fuzzy.txt",
		);
		expect(trailing.newContent).toBe("hi\n");

		const quotes = applyEditsToNormalizedContent(
			normalizeToLF("say “hi”\n"),
			[{ oldText: 'say "hi"\n', newText: 'say "bye"\n' }],
			"quotes.txt",
		);
		expect(quotes.newContent).toBe('say "bye"\n');
	});

	it("keeps exact matches on the untouched fast path", () => {
		const result = applyEditsToNormalizedContent("abc\n", [{ oldText: "abc", newText: "abd" }], "exact.txt");
		expect(result.newContent).toBe("abd\n");
	});

	it("surfaces the diagnosis through the real edit tool", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "router_agent.py");
		await writeFile(filePath, routerFileContent("\r\n"), "utf8");

		const definition = createEditToolDefinition(dir);
		const error = await definition
			.execute(
				"tool-1",
				{
					path: "router_agent.py",
					edits: [
						{
							oldText: "挂在 /internal/rooms/{room_id}/... 下，不进 openapi。n",
							newText: "挂在 /internal/rooms/{room_id}/... 下，不进 openapi。",
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			)
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Closest match: line 3");
		expect((error as Error).message).toContain('extra trailing character that is not in the file: "n"');
	});
});
