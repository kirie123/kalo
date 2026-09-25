import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Regression: cancelled auto-compaction must anchor backoff so the same
 * context does not immediately re-trigger a new compaction cycle.
 *
 * Two cancellation paths are covered:
 *   1. An extension returns { cancel: true } from session_before_compact.
 *   2. session.abortCompaction() is called while compaction is in flight
 *      (simulated by aborting inside the session_before_compact hook, before
 *      the LLM call, so the post-call signal.aborted check fires).
 *
 * In both cases the invariant is:
 *   - exactly one compaction_start is emitted for the original attempt
 *   - subsequent _checkCompaction calls on the same context emit no further events
 *   - _compactionConsecutiveFailures stays at 0 (cancel ≠ failure)
 *   - even after three consecutive cancellations the circuit breaker is NOT tripped
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

function useFixedStreamFn(harness: Harness, message: AssistantMessage): void {
	const streamFunction: StreamFn = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const response = { ...message, api: model.api, provider: model.provider, model: model.id };
			stream.push({ type: "done", reason: "stop", message: response });
		});
		return stream;
	};
	harness.session.agent.streamFunction = streamFunction;
}

function seedOverThresholdSession(harness: Harness): AssistantMessage {
	harness.settingsManager.applyOverrides({
		compaction: { keepRecentTokens: 1 },
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});
	const model = harness.getModel();
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "seed message" }],
		timestamp: now - 1000,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(Math.floor(model.contextWindow * 0.95)),
	};
	assistant.content = [{ type: "text", text: "assistant response" }];
	harness.sessionManager.appendMessage(assistant);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "tail" }],
		timestamp: now,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return assistant;
}

function growConversation(harness: Harness, text: string): void {
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession auto-compaction cancel backoff", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("extension cancel: same context does not re-trigger compaction", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				{
					name: "cancel-compaction",
					factory: (pi) => {
						pi.on("session_before_compact", async () => ({ cancel: true }));
					},
				},
			],
		});
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);
		// Extension cancels before the LLM is called, but _getSummarizationRequestAuth
		// runs before compaction_start and requires streamFunction !== streamSimple.
		useFixedStreamFn(harness, { ...fauxAssistantMessage("summary"), usage: createUsage(10) });
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		// First check: extension cancels → one start/end pair, aborted=true.
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]?.aborted).toBe(true);

		// Cancel is not a failure: failure counter must remain 0.
		expect(internals._compactionConsecutiveFailures).toBe(0);

		// Same context: subsequent checks skip silently (no new events, no LLM calls).
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("extension cancel: new message lifts backoff and allows retry", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				{
					name: "cancel-compaction",
					factory: (pi) => {
						pi.on("session_before_compact", async () => ({ cancel: true }));
					},
				},
			],
		});
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);
		useFixedStreamFn(harness, { ...fauxAssistantMessage("summary"), usage: createUsage(10) });
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);

		// One new message in the context should lift the anchor.
		growConversation(harness, "follow-up");
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);

		// A second compaction_start must appear (the extension cancels again, but it did retry).
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(internals._compactionConsecutiveFailures).toBe(0);
	});

	it("abort signal: same context does not re-trigger after abortCompaction()", async () => {
		// The extension calls abortCompaction() before returning, simulating an
		// external abort arriving while the before_compact hook is in flight.
		// The extension does NOT return cancel:true, so the cancel-path is not
		// taken; instead the post-LLM signal.aborted check fires.
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				{
					name: "abort-during-hook",
					factory: (pi) => {
						pi.on("session_before_compact", async () => {
							harness.session.abortCompaction();
							return undefined;
						});
					},
				},
			],
		});
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);

		// Provide a summary response so _compactSessionWithPrompt has something to
		// return (the abort check happens after the LLM call returns).
		const summary: AssistantMessage = {
			...fauxAssistantMessage("summary after abort"),
			usage: createUsage(10),
		};
		useFixedStreamFn(harness, summary);

		const internals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]?.aborted).toBe(true);

		// Abort is not a counted failure.
		expect(internals._compactionConsecutiveFailures).toBe(0);

		// Same context: must stay silent.
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("three consecutive extension cancels do NOT trip the circuit breaker", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				{
					name: "always-cancel",
					factory: (pi) => {
						pi.on("session_before_compact", async () => ({ cancel: true }));
					},
				},
			],
		});
		harnesses.push(harness);
		const assistant = seedOverThresholdSession(harness);
		useFixedStreamFn(harness, { ...fauxAssistantMessage("summary"), usage: createUsage(10) });
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		// Trigger → cancel → grow × 3.
		for (let i = 0; i < 3; i++) {
			await expect(internals._checkCompaction(assistant, false)).resolves.toBe(false);
			growConversation(harness, `growth ${i}`);
		}

		// Three cancels must not count as failures or trip the breaker.
		expect(internals._compactionConsecutiveFailures).toBe(0);
		expect(internals._compactionCircuitBreakerTripped).toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(3);
	});
});
