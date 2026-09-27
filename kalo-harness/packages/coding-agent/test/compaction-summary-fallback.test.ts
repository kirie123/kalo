import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function okResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function blockedResponse(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage:
			"This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
		timestamp: Date.now(),
	};
}

const messages: AgentMessage[] = [
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret chain of thought that trips the classifier" },
			{ type: "text", text: "visible answer" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage,
];

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "entry-keep",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 100000,
		fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set() },
		settings: {
			enabled: true,
			reserveTokens: 2000,
			keepRecentTokens: 20000,
			thinkingLevel: "off",
			// Default is reuseMessages: true — tier 1 uses the cache-friendly shape.
			reuseMessages: true,
		},
	};
}

describe("compaction summarization failure escalation", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	it("retries with a sanitized (thinking-stripped) request when the first attempt is blocked", async () => {
		completeSimpleMock
			.mockResolvedValueOnce(blockedResponse())
			.mockResolvedValueOnce(okResponse("## Goal\nrecovered"));

		const result = await compact(preparation(), createModel(), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(result.summary).toContain("recovered");
		// The retry serializes the conversation (no prompt-cache reuse) with thinking
		// stripped, so the model's chain-of-thought must not appear in the 2nd request.
		const secondRequest = JSON.stringify(completeSimpleMock.mock.calls[1][1]);
		expect(secondRequest).not.toContain("secret chain of thought");
	});

	it("falls back to a local summary when both attempts are blocked", async () => {
		completeSimpleMock.mockResolvedValue(blockedResponse());

		const result = await compact(preparation(), createModel(), "test-key");

		// Tier 1 + tier 2 both attempted, then local fallback — no throw.
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(result.summary).toContain("Automatic summary unavailable");
		// File ops are still recorded so the compaction is genuinely effective.
		expect(result.details).toMatchObject({ readFiles: ["a.ts"] });
	});
});
