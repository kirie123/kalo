import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Behavioral locks for auto-compaction failure backoff.
 *
 * Covered here:
 * - After a counted auto-compaction failure, automatic checks skip compaction
 *   silently (no compaction_start/compaction_end) until at least one new
 *   message has entered the context.
 * - Once the message list grows past the failure anchor, the next automatic
 *   check retries normally.
 * - Three counted failures trip the circuit breaker; a tripped breaker skips
 *   compaction without starting it even after the context grows.
 * - Manual compact() is not subject to backoff: it runs immediately and an
 *   effective result clears the failure count and the backoff anchor.
 */

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_compactionConsecutiveFailures: number;
	_compactionCircuitBreakerTripped: boolean;
	_autoCompactionBackoffAnchor: number | undefined;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** streamFn that always answers with the given assistant message. */
function useFixedStreamFn(harness: Harness, message: AssistantMessage): () => number {
	let callCount = 0;
	const streamFunction: StreamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const response = { ...message, api: model.api, provider: model.provider, model: model.id };
			if (response.stopReason === "pending") {
				const error: AssistantMessage = {
					...response,
					stopReason: "error",
					errorMessage: "Scripted response ended without a stop reason",
				};
				stream.push({ type: "error", reason: "error", error });
			} else if (response.stopReason === "error" || response.stopReason === "aborted") {
				stream.push({ type: "error", reason: response.stopReason, error: response });
			} else {
				stream.push({ type: "done", reason: response.stopReason, message: response });
			}
		});
		return stream;
	};
	harness.session.agent.streamFunction = streamFunction;
	return () => callCount;
}

/**
 * Seed a session whose estimated context sits above the compaction threshold,
 * so _checkCompaction takes the Case 2 (threshold) path. Returns the assistant
 * message to pass to _checkCompaction.
 */
function seedOverThresholdSession(harness: Harness): AssistantMessage {
	harness.settingsManager.applyOverrides({
		compaction: { keepRecentTokens: 1 },
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});
	const model = harness.getModel();
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		// Reported context sits above the compaction threshold for this model.
		usage: createUsage(Math.floor(model.contextWindow * 0.95)),
	};
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "tail" }],
		timestamp: now,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return assistant;
}

/** Simulate conversation progress: a new message enters the context. */
function growConversation(harness: Harness, text: string): void {
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

const failure = (): AssistantMessage => ({
	...fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
	usage: createUsage(10),
});

describe("AgentSession auto-compaction failure backoff", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("skips automatic compaction silently after a failure until the context grows", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);
		const getCallCount = useFixedStreamFn(harness, failure());
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		// First check runs compaction and fails.
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(internals._compactionConsecutiveFailures).toBe(1);

		// Same context: the next automatic checks skip silently (no events, no LLM call).
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(getCallCount()).toBe(1);

		// A new message lifts the backoff: the next check retries (and fails again).
		growConversation(harness, "follow-up question");
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(getCallCount()).toBe(2);
		expect(internals._compactionConsecutiveFailures).toBe(2);
	});

	it("trips the circuit breaker after three counted failures and stays silent afterwards", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);
		useFixedStreamFn(harness, failure());
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		for (let i = 0; i < 3; i++) {
			await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
			growConversation(harness, `growth ${i}`);
		}

		expect(internals._compactionConsecutiveFailures).toBe(3);
		expect(internals._compactionCircuitBreakerTripped).toBe(true);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(3);
		expect(harness.eventsOfType("compaction_end").at(-1)?.circuitBreakerTripped).toBe(true);

		// Even with a grown context, the tripped breaker skips compaction without starting it.
		growConversation(harness, "more growth");
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(3);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(3);
	});

	it("does not block manual compact() during backoff and clears failure tracking on success", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		// One counted failure puts automatic compaction into backoff.
		useFixedStreamFn(harness, failure());
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(internals._compactionConsecutiveFailures).toBe(1);
		expect(internals._autoCompactionBackoffAnchor).toBe(harness.session.agent.state.messages.length);

		// The user explicitly asks for compaction: runs immediately despite backoff.
		const summary: AssistantMessage = {
			...fauxAssistantMessage("manual summary"),
			usage: createUsage(10),
		};
		useFixedStreamFn(harness, summary);
		const result = await harness.session.compact();

		expect(result.summary).toContain("manual summary");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "manual", aborted: false });

		// Effective manual compaction resets the failure count and the backoff anchor.
		expect(internals._compactionConsecutiveFailures).toBe(0);
		expect(internals._compactionCircuitBreakerTripped).toBe(false);
		expect(internals._autoCompactionBackoffAnchor).toBeUndefined();
	});
});
