import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendTranscript, renderTranscript } from "../src/extensions/subagent/transcript.ts";

/**
 * A resumable child accumulates several turns, so the transcript is appended to
 * once per turn rather than overwritten. These tests pin that rendering and the
 * append behaviour.
 *
 * Design: doc/2026-09-10-子agent-idle-watchdog与转录落盘.md
 *         doc/2026-09-11-可续写子agent与主agent派生.md
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
		turn: 1,
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
		expect(md).toContain("## 第 1 轮");
		expect(md).toContain("- 结束原因：正常结束");
		expect(md).toContain("第 1 步 · assistant");
		expect(md).toContain("先看看目录结构");
		expect(md).toContain("调用 `ls`");
		expect(md).toContain('"path": "A"');
		expect(md).toContain("a.ts\nb.ts");
	});

	// The title block belongs to the file, not to each turn: repeating it on
	// every resume would make the transcript read like several separate runs.
	it("writes the document header only on the first turn", () => {
		const second = renderTranscript([], { ...ctx, turn: 2, outcome: "报错中断：boom" });
		expect(second).not.toContain("# 子 agent 转录");
		expect(second).toContain("## 第 2 轮");
		expect(second).toContain("- 结束原因：报错中断：boom");
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

	it("creates the file and its parent directory on the first turn", () => {
		const path = join(tempDir, "subagent", "parent-1", "subagent-1.md");
		expect(appendTranscript(path, "# hello")).toBe(path);
		expect(readFileSync(path, "utf8")).toBe("# hello");
	});

	// The whole point of per-turn transcripts: turn 2 must not erase turn 1.
	it("appends later turns instead of overwriting", () => {
		const path = join(tempDir, "subagent", "parent-1", "subagent-1.md");
		appendTranscript(path, "## 第 1 轮\n");
		appendTranscript(path, "## 第 2 轮\n");
		const content = readFileSync(path, "utf8");
		expect(content).toContain("## 第 1 轮");
		expect(content).toContain("## 第 2 轮");
	});

	// A full disk or read-only profile must not turn a usable child result into
	// an error, so a write failure degrades to "no transcript path".
	it("returns undefined instead of throwing when the write fails", () => {
		const blocker = join(tempDir, "blocker");
		writeFileSync(blocker, "not a directory");
		// mkdirSync must fail: a plain file sits where the parent directory goes.
		expect(appendTranscript(join(blocker, "child", "x.md"), "x")).toBeUndefined();
	});
});
