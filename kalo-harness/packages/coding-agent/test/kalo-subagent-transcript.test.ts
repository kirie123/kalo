import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTranscript, transcriptFileName, writeTranscript } from "../src/extensions/subagent/transcript.ts";

/**
 * A child agent's history is in-memory only, so a run cut short by the liveness
 * watchdog or a user abort leaves the parent with nothing to inspect. These
 * tests pin the transcript that replaces it.
 *
 * Design: doc/2026-09-10-子agent-idle-watchdog与转录落盘.md
 */
describe("subagent transcript", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-kalo-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const ctx = {
		prompt: "调研 A 目录",
		description: "调研任务",
		tools: ["read", "grep"],
		outcome: "正常结束",
	};

	it("renders assistant text, tool calls and tool results", () => {
		const md = renderTranscript(
			[
				{ role: "user", content: [{ type: "text", text: "调研 A 目录" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "先看看目录结构" },
						{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "A" } },
					],
				},
				{ role: "toolResult", toolName: "ls", isError: false, content: [{ type: "text", text: "a.ts\nb.ts" }] },
			],
			ctx,
		);

		expect(md).toContain("# 子 agent 转录：调研任务");
		expect(md).toContain("- 结束原因：正常结束");
		expect(md).toContain("第 1 步 · assistant");
		expect(md).toContain("先看看目录结构");
		expect(md).toContain("调用 `ls`");
		expect(md).toContain('"path": "A"');
		expect(md).toContain("a.ts\nb.ts");
	});

	it("clips a runaway tool result instead of writing it whole", () => {
		const huge = "x".repeat(20_000);
		const md = renderTranscript(
			[{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: huge }] }],
			ctx,
		);
		expect(md).toContain("[truncated");
		expect(md.length).toBeLessThan(10_000);
	});

	it("marks failed tool results", () => {
		const md = renderTranscript(
			[{ role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] }],
			ctx,
		);
		expect(md).toContain("`read` 失败");
	});

	// Windows forbids ':' in file names and this product ships on Windows first,
	// so a raw ISO timestamp in the name would make every transcript write fail.
	it("produces a file name with no characters Windows forbids", () => {
		const name = transcriptFileName(new Date("2026-09-10T12:34:56.789Z"));
		expect(name).not.toMatch(/[:*?"<>|]/);
		expect(name.endsWith(".md")).toBe(true);
	});

	it("writes under subagent-transcripts and returns the path", () => {
		const path = writeTranscript(tempDir, "# hello");
		expect(path).toBeDefined();
		expect(existsSync(path!)).toBe(true);
		expect(readFileSync(path!, "utf8")).toBe("# hello");
		expect(basename(join(path!, ".."))).toBe("subagent-transcripts");
	});

	// A full disk or read-only profile must not turn a usable child result into
	// an error, so a write failure degrades to "no transcript path".
	it("returns undefined instead of throwing when the write fails", () => {
		const blocked = join(tempDir, "not-a-dir");
		// A file where the transcript directory's parent should be: mkdirSync fails.
		writeTranscript(tempDir, "seed");
		expect(writeTranscript(join(blocked, "\0invalid"), "x")).toBeUndefined();
	});
});
