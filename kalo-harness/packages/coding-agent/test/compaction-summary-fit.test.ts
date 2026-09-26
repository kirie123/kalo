import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateTokens, trimOldestToFitSummaryWindow } from "../src/core/compaction/compaction.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function fakeModel(contextWindow: number, maxTokens: number): Model<any> {
	return { contextWindow, maxTokens } as Model<any>;
}

function totalTokens(messages: AgentMessage[]): number {
	return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

describe("trimOldestToFitSummaryWindow", () => {
	it("returns messages unchanged when they already fit", () => {
		const messages = [userMessage("a".repeat(400)), userMessage("b".repeat(400))];
		const result = trimOldestToFitSummaryWindow(messages, fakeModel(200_000, 20_000), "summarize", undefined);
		expect(result).toBe(messages);
	});

	it("drops the oldest messages until the summary input fits the effective window", () => {
		// 20 messages of ~1000 tokens each (~4000 chars) = ~20000 tokens.
		const messages = Array.from({ length: 20 }, (_, i) => userMessage(`${i}:${"x".repeat(4000)}`));
		const model = fakeModel(30_000, 20_000); // effective budget ~= 30000 - 20000 - overhead
		const result = trimOldestToFitSummaryWindow(messages, model, "summarize", undefined);

		expect(result.length).toBeLessThan(messages.length);
		// The most recent message is always kept.
		expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
		// The kept slice fits within the reserved budget.
		expect(totalTokens(result)).toBeLessThanOrEqual(30_000 - 20_000);
		// It is a suffix (oldest dropped, order preserved).
		const start = messages.length - result.length;
		expect(result).toEqual(messages.slice(start));
	});

	it("keeps at least the most recent message even under a pathologically small window", () => {
		const messages = [userMessage("old".repeat(1000)), userMessage("new".repeat(1000))];
		const result = trimOldestToFitSummaryWindow(messages, fakeModel(10, 5), "summarize", undefined);
		expect(result).toEqual(messages.slice(-1));
	});

	it("does nothing when the model reports no context window", () => {
		const messages = [userMessage("x".repeat(40000))];
		const result = trimOldestToFitSummaryWindow(messages, fakeModel(0, 0), "summarize", undefined);
		expect(result).toBe(messages);
	});
});
