import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

/**
 * Behavioral locks for cut-point selection and threshold semantics.
 *
 * Covered here:
 * - A single oversized tool result is never cut away from its tool call. When it
 *   alone exceeds the keep-recent budget, the cut point slides all the way back
 *   and prepareCompaction() reports nothing to compact (auto-compaction then
 *   silently no-ops instead of failing).
 * - The oldest region is always what gets summarized; the newest tail is kept.
 * - Tool results are truncated to 2000 chars inside the summarization payload.
 * - The trigger threshold is `contextTokens > contextWindow - reserveTokens`
 *   (a strict reserve margin, not a percentage gate such as 95%).
 */

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createToolCallAssistant(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "/tmp/big" } }],
		usage: createMockUsage(100, 50),
		stopReason: "toolUse",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createToolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function messageTexts(messages: AgentMessage[]): string[] {
	return messages.map((message) => {
		if (message.role === "user") return message.content as string;
		if (message.role === "assistant") {
			const block = message.content[0];
			return block.type === "text" ? block.text : `toolCall:${block.type}`;
		}
		if (message.role === "toolResult") {
			const block = message.content[0];
			return block.type === "text" ? block.text : "toolResult";
		}
		return message.role;
	});
}

describe("oversized tool result handling", () => {
	it("never cuts at a tool result: a trailing oversized tool result forces the keep-everything fallback", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("request")),
			createMessageEntry(createToolCallAssistant("call-1")),
			// ~10000 estimated tokens, far above any reasonable keepRecentTokens.
			createMessageEntry(createToolResult("call-1", "x".repeat(40_000))),
		];

		const result = findCutPoint(entries, 0, entries.length, 1000);

		// The tool result is not a valid cut point, and no cut point exists at or
		// after it, so the cut slides back to the first cut point: keep everything.
		expect(result.firstKeptEntryIndex).toBe(0);
		expect(result.isSplitTurn).toBe(false);
	});

	it("prepareCompaction returns undefined when the only oversized content is a trailing tool result", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("request")),
			createMessageEntry(createToolCallAssistant("call-1")),
			createMessageEntry(createToolResult("call-1", "x".repeat(40_000))),
		];

		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1000 };

		// Nothing can be summarized without orphaning the tool result from its
		// tool call, so compaction is structurally impossible and is skipped.
		expect(prepareCompaction(entries, settings)).toBeUndefined();
	});

	it("keeps an oversized tool result inside the split-turn prefix rather than dropping it", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("request")),
			createMessageEntry(createToolCallAssistant("call-1")),
			createMessageEntry(createToolResult("call-1", "x".repeat(40_000))),
			createMessageEntry(createAssistantMessage("final answer")),
		];

		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 };
		const preparation = prepareCompaction(entries, settings);

		expect(preparation).toBeDefined();
		expect(preparation!.isSplitTurn).toBe(true);
		// The cut lands on the final assistant message; the oversized tool result
		// stays with its tool call inside the summarized turn prefix.
		expect(preparation!.turnPrefixMessages).toHaveLength(3);
		expect(preparation!.turnPrefixMessages[2].role).toBe("toolResult");
		expect(preparation!.messagesToSummarize).toHaveLength(0);
	});

	it("truncates tool results to 2000 characters in the summarization payload", () => {
		const text = "y".repeat(5000);
		const messages = convertToLlm([
			createUserMessage("request"),
			createToolCallAssistant("call-1"),
			createToolResult("call-1", text),
		]);

		const serialized = serializeConversation(messages);

		expect(serialized).not.toContain(text);
		expect(serialized).toContain("[... 3000 more characters truncated]");
	});
});

describe("cut-point priority: oldest region is summarized first", () => {
	it("summarizes the oldest regions in order and keeps the newest tail", () => {
		const filler = "f".repeat(400); // ~100 tokens per message
		const entries: SessionEntry[] = [
			// Old region
			createMessageEntry(createUserMessage(`old user ${filler}`)),
			createMessageEntry(createAssistantMessage(`old assistant ${filler}`)),
			// Middle region
			createMessageEntry(createUserMessage(`middle user ${filler}`)),
			createMessageEntry(createAssistantMessage(`middle assistant ${filler}`)),
			// Recent tail (small, fits the keep-recent budget)
			createMessageEntry(createUserMessage("recent user")),
			createMessageEntry(createAssistantMessage("recent assistant")),
		];

		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 5 };
		const preparation = prepareCompaction(entries, settings);

		expect(preparation).toBeDefined();
		const summarized = messageTexts(preparation!.messagesToSummarize);
		// Old and middle regions are summarized, in original order.
		expect(summarized).toHaveLength(4);
		expect(summarized[0]).toContain("old user");
		expect(summarized[1]).toContain("old assistant");
		expect(summarized[2]).toContain("middle user");
		expect(summarized[3]).toContain("middle assistant");
		// The recent tail is kept: the first kept entry is the recent user message.
		const firstKept = entries.find((entry) => entry.id === preparation!.firstKeptEntryId);
		expect(firstKept?.type).toBe("message");
		expect(messageTexts([(firstKept as SessionMessageEntry).message])[0]).toBe("recent user");
		expect(summarized.join("\n")).not.toContain("recent");
	});

	it("resumes the next compaction at the previous boundary instead of re-summarizing from scratch", () => {
		const filler = "f".repeat(400);
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage(`old user ${filler}`)),
			createMessageEntry(createAssistantMessage(`old assistant ${filler}`)),
			createMessageEntry(createUserMessage(`middle user ${filler}`)),
			createMessageEntry(createAssistantMessage(`middle assistant ${filler}`)),
			createMessageEntry(createUserMessage("recent user")),
			createMessageEntry(createAssistantMessage("recent assistant")),
		];

		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 5 };
		const first = prepareCompaction(entries, settings);
		expect(first).toBeDefined();

		// Simulate the first compaction being persisted: summary entry keeps the
		// recent tail, then a new region grows after it.
		const compactionEntry: SessionEntry = {
			type: "compaction",
			id: `test-id-${entryCounter++}`,
			parentId: lastId,
			timestamp: new Date().toISOString(),
			summary: "summary of old and middle",
			firstKeptEntryId: first!.firstKeptEntryId,
			tokensBefore: first!.tokensBefore,
		};
		lastId = compactionEntry.id;
		const after: SessionEntry[] = [
			...entries,
			compactionEntry,
			createMessageEntry(createUserMessage(`new user ${filler}`)),
			createMessageEntry(createAssistantMessage(`new assistant ${filler}`)),
			createMessageEntry(createUserMessage("newest user")),
			createMessageEntry(createAssistantMessage("newest assistant")),
		];

		const second = prepareCompaction(after, settings);
		expect(second).toBeDefined();
		// The previous summary is threaded through for an iterative update.
		expect(second!.previousSummary).toBe("summary of old and middle");
		const summarized = messageTexts(second!.messagesToSummarize).join("\n");
		// Only the region after the previous boundary is summarized now.
		expect(summarized).toContain("recent user");
		expect(summarized).toContain("new user");
		expect(summarized).not.toContain("old user");
		expect(summarized).not.toContain("middle user");
	});
});

describe("compaction trigger threshold", () => {
	// There is no percentage gate (e.g. 95%); the trigger is a strict reserve
	// margin: contextTokens > contextWindow - reserveTokens.
	const settings: CompactionSettings = {
		enabled: true,
		reserveTokens: 10_000,
		keepRecentTokens: 20_000,
		thinkingLevel: "off",
		reuseMessages: false,
	};

	it("does not trigger at or below the reserve boundary", () => {
		expect(shouldCompact(89_999, 100_000, settings)).toBe(false);
		expect(shouldCompact(90_000, 100_000, settings)).toBe(false);
	});

	it("triggers one token above the reserve boundary", () => {
		expect(shouldCompact(90_001, 100_000, settings)).toBe(true);
	});

	it("never triggers when disabled, regardless of usage", () => {
		expect(shouldCompact(100_000, 100_000, { ...settings, enabled: false })).toBe(false);
	});
});
