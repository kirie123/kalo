/**
 * Subagent transcript rendering and persistence.
 *
 * A child agent's history lives in an in-memory SessionManager, so when the run
 * is cut short (stalled watchdog, user abort) or its final text gets truncated,
 * the parent has no way to see what actually happened. This module serializes
 * the child's messages to a standalone markdown file the parent can `read`.
 *
 * The file deliberately does NOT go under the sessions directory: the desktop
 * lists every `.jsonl` there as a user-visible conversation, and child runs must
 * not show up in that list.
 *
 * Design: doc/2026-09-10-子agent-idle-watchdog与转录落盘.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Per-block cap inside the transcript. Generous: this file is the fallback. */
const MAX_BLOCK_CHARS = 4_000;

function clip(text: string, limit: number = MAX_BLOCK_CHARS): string {
	return text.length > limit ? `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]` : text;
}

/** Text of a content array or plain string message body. */
function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Tool call blocks of an assistant message. */
function toolCalls(content: unknown): Array<{ id: string; name: string; arguments: unknown }> {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(c): c is { type: "toolCall"; id: string; name: string; arguments: unknown } =>
			(c as { type?: string }).type === "toolCall",
	);
}

export interface TranscriptContext {
	/** The prompt the parent handed to the child. */
	prompt: string;
	/** Task summary from the `agent` call, when given. */
	description?: string;
	/** Tool names the child was allowed to use. */
	tools: string[];
	/** Why the run ended, rendered verbatim into the header. */
	outcome: string;
}

/**
 * Render a child's message list as markdown: one section per message, with tool
 * calls and their results inline. Blocks are clipped so a runaway tool result
 * cannot produce a multi-megabyte file.
 */
export function renderTranscript(messages: readonly unknown[], ctx: TranscriptContext): string {
	const lines: string[] = [];
	lines.push(`# 子 agent 转录${ctx.description ? `：${ctx.description}` : ""}`);
	lines.push("");
	lines.push(`- 结束原因：${ctx.outcome}`);
	lines.push(`- 可用工具：${ctx.tools.join(", ")}`);
	lines.push("");
	lines.push("## 任务 prompt");
	lines.push("");
	lines.push(clip(ctx.prompt));
	lines.push("");
	lines.push("## 过程");
	lines.push("");

	let step = 0;
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
		if (message.role === "assistant") {
			step++;
			const text = blocksText(message.content).trim();
			lines.push(`### 第 ${step} 步 · assistant`);
			lines.push("");
			if (text) {
				lines.push(clip(text));
				lines.push("");
			}
			for (const call of toolCalls(message.content)) {
				lines.push(`- 调用 \`${call.name}\``);
				lines.push("");
				lines.push("```json");
				lines.push(clip(safeJson(call.arguments), 1_000));
				lines.push("```");
				lines.push("");
			}
		} else if (message.role === "toolResult") {
			const text = blocksText(message.content).trim();
			lines.push(`- \`${message.toolName ?? "tool"}\` ${message.isError ? "失败" : "结果"}：`);
			lines.push("");
			lines.push("```");
			lines.push(clip(text || "(空)"));
			lines.push("```");
			lines.push("");
		}
		// user/custom messages carry the prompt already rendered above, or
		// UI-only notifications with nothing worth replaying.
	}

	return `${lines.join("\n")}\n`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Timestamped, collision-resistant file name.
 *
 * `:` and `.` are stripped from the ISO timestamp: Windows forbids `:` in file
 * names, and this product ships on Windows first.
 */
export function transcriptFileName(now: Date = new Date()): string {
	const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}.md`;
}

/**
 * Write a transcript under `<agentDir>/subagent-transcripts/` and return its
 * path. Returns undefined on any failure: a transcript problem (full disk,
 * read-only profile) must never turn a usable child result into an error.
 */
export function writeTranscript(agentDir: string, content: string): string | undefined {
	try {
		const dir = join(agentDir, "subagent-transcripts");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, transcriptFileName());
		writeFileSync(path, content, "utf8");
		return path;
	} catch {
		return undefined;
	}
}
