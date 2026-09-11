/**
 * Subagent transcript rendering and persistence.
 *
 * When a run is cut short (stalled watchdog, user abort) or its final text gets
 * truncated, the parent has no way to see what actually happened. This module
 * serializes the child's messages to a markdown file the parent can `read`.
 *
 * The transcript now sits beside the child's session file, under the parent's
 * cwd bucket (see children.ts for why), and is appended to once per turn: a
 * resumable child has a history spanning several turns, and overwriting would
 * leave only the last one readable.
 *
 * Design: doc/2026-09-11-可续写子agent与主agent派生.md
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
	/** 1-based turn number; a resumed child appends turn 2, 3, ... */
	turn: number;
}

/**
 * Render one turn of a child's run as a markdown section.
 *
 * `messages` is the slice belonging to this turn only, not the whole history —
 * the caller tracks where the previous turn ended, so a resumed child does not
 * re-render everything it already wrote.
 */
export function renderTranscript(messages: readonly unknown[], ctx: TranscriptContext): string {
	const lines: string[] = [];
	if (ctx.turn <= 1) {
		lines.push(`# 子 agent 转录${ctx.description ? `：${ctx.description}` : ""}`);
		lines.push("");
		lines.push(`- 可用工具：${ctx.tools.join(", ")}`);
		lines.push("");
	}
	lines.push(`## 第 ${ctx.turn} 轮`);
	lines.push("");
	lines.push(`- 结束原因：${ctx.outcome}`);
	lines.push("");
	lines.push(`### 本轮 prompt`);
	lines.push("");
	lines.push(clip(ctx.prompt));
	lines.push("");
	lines.push("### 过程");
	lines.push("");

	let step = 0;
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
		if (message.role === "assistant") {
			step++;
			const text = blocksText(message.content).trim();
			lines.push(`#### 第 ${step} 步 · assistant`);
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
 * Append one turn's transcript section to `path`, creating it on the first
 * turn. Returns the path, or undefined on any failure: a transcript problem
 * (full disk, read-only profile) must never turn a usable child result into an
 * error.
 */
export function appendTranscript(path: string, content: string): string | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path)) {
			appendFileSync(path, content, "utf8");
		} else {
			writeFileSync(path, content, "utf8");
		}
		return path;
	} catch {
		return undefined;
	}
}
