import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens, estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Behavioral locks for compaction failure semantics on the AgentSession path.
 *
 * Covered here:
 * - Summarization failures have no mechanical fallback: the error propagates,
 *   `compaction_end` carries `Auto-compaction failed: ...`, the message list is
 *   untouched, and three consecutive failures trip the circuit breaker.
 * - Aborting an in-flight auto-compaction emits `compaction_end(aborted: true)`
 *   and leaves both the session entries and the agent message list unmodified.
 * - Turn prefix summarization (split turns) retries are bounded by
 *   `settings.retry`; exhaustion fails the compaction instead of retrying
 *   forever or degrading silently.
 * - Non-retryable errors (403 / 400 Consumer Terms) are never retried and fail
 *   immediately, matching the production failure `Turn prefix summarization
 *   failed: 400 {...Consumer Terms...}`.
 * - A successful auto-compaction replaces agent.state.messages with
 *   [summary + kept tail], drops the estimated context well below the
 *   threshold, and does not immediately retrigger on the next check.
 */

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
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

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

/** streamFn that responds with the given sequence of assistant messages across calls. */
function useScriptedStreamFn(harness: Harness, script: AssistantMessage[]): () => number {
	let callCount = 0;
	const streamFunction: StreamFn = (model) => {
		const message = script[callCount] ?? script[script.length - 1]!;
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

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	// A trailing user message keeps the cut point on a turn start, so the
	// compaction takes the main history-summary path (no split turn).
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "tail" }],
		timestamp: now,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/**
 * Seed a session whose cut point lands mid-turn: the final assistant message is
 * kept, and the user/tool-call/tool-result prefix of its turn is summarized by
 * the turn prefix summarization call.
 */
function seedSplitTurnSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 5 } });
	const now = Date.now();
	const model: Model<string> = harness.getModel();

	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "old request" }],
		timestamp: now - 5000,
	});
	const oldAssistant = createAssistant(harness, { stopReason: "stop", totalTokens: 100, timestamp: now - 4000 });
	oldAssistant.content = [{ type: "text", text: "old answer" }];
	harness.sessionManager.appendMessage(oldAssistant);

	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "big turn request" }],
		timestamp: now - 3000,
	});
	const toolCallAssistant: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "toolUse", timestamp: now - 2000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	toolCallAssistant.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/big" } }];
	harness.sessionManager.appendMessage(toolCallAssistant);
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "x".repeat(4000) }],
		isError: false,
		timestamp: now - 1000,
	});
	const finalAssistant = createAssistant(harness, { stopReason: "stop", totalTokens: 100, timestamp: now });
	finalAssistant.content = [{ type: "text", text: "final answer" }];
	harness.sessionManager.appendMessage(finalAssistant);

	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction failure semantics", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("auto-compaction summarization failure emits an error, keeps messages, and trips the circuit breaker after 3 failures", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const messagesBefore = harness.session.agent.state.messages.slice();

		// There is no fallback summarizer: each attempt fails after bounded retries.
		for (let i = 0; i < 3; i++) {
			await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		}

		expect(getCallCount()).toBe(9); // 3 compactions x (1 initial + 2 retries)
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(3);
		for (const end of ends) {
			expect(end.result).toBeUndefined();
			expect(end.aborted).toBe(false);
			expect(end.errorMessage).toBe("Auto-compaction failed: Summarization failed: 503 service unavailable");
		}
		expect(ends[2]?.circuitBreakerTripped).toBe(true);

		// The message list and session entries are untouched by the failures.
		expect(harness.session.agent.state.messages).toEqual(messagesBefore);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		// Once tripped, the breaker skips compaction without even starting it.
		const startsBefore = harness.eventsOfType("compaction_start").length;
		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(startsBefore);
		expect(getCallCount()).toBe(9);
	});

	it("retries upstream-unavailable wording through the summarization retry policy", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		// The exact production wording: "Upstream service temporarily unavailable"
		// is a transient gateway failure and must honor the retry policy instead of
		// burning a circuit-breaker count on the first attempt.
		const error: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Upstream service temporarily unavailable",
			}),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(getCallCount()).toBe(4); // 1 initial + 3 retries
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(3);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Auto-compaction failed: Summarization failed: Upstream service temporarily unavailable",
		);
	});

	it("aborted auto-compaction emits compaction_end(aborted) and does not modify messages or entries", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);

		// streamFn that hangs until the summarization request is aborted.
		const streamFunction: StreamFn = (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			options?.signal?.addEventListener(
				"abort",
				() => {
					const aborted: AssistantMessage = {
						...fauxAssistantMessage("", { stopReason: "aborted" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(0),
					};
					stream.push({ type: "error", reason: "aborted", error: aborted });
				},
				{ once: true },
			);
			return stream;
		};
		harness.session.agent.streamFunction = streamFunction;
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const messagesBefore = harness.session.agent.state.messages.slice();
		const entriesBefore = harness.sessionManager.getEntries().length;

		const compactionPromise = sessionInternals._runAutoCompaction("threshold", false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isCompacting).toBe(true);
		harness.session.abortCompaction();

		await expect(compactionPromise).resolves.toBe(false);

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({ reason: "threshold", aborted: true, result: undefined });
		expect(compactionEnd?.errorMessage).toBeUndefined();
		// No half-written state: no compaction entry, no message list mutation.
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.session.agent.state.messages).toEqual(messagesBefore);
	});

	it("bounds turn prefix summarization retries and fails the compaction on exhaustion", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedSplitTurnSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });

		const historySummary: AssistantMessage = {
			...fauxAssistantMessage("history summary"),
			usage: createUsage(10),
		};
		const prefixError: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			usage: createUsage(10),
		};
		// Call 1 summarizes the history; calls 2+ are the failing prefix summary.
		const getCallCount = useScriptedStreamFn(harness, [historySummary, prefixError, prefixError, prefixError]);
		const messagesBefore = harness.session.agent.state.messages.slice();

		await expect(harness.session.compact()).rejects.toThrow(
			"Turn prefix summarization failed: 503 service unavailable",
		);

		// 1 history call + (1 initial + 2 retries) prefix calls; no infinite retry.
		expect(getCallCount()).toBe(4);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(2);
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({ reason: "manual", aborted: false, result: undefined });
		expect(compactionEnd?.errorMessage).toBe(
			"Compaction failed: Turn prefix summarization failed: 503 service unavailable",
		);
		// Failed compaction leaves no partial result behind.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.session.agent.state.messages).toEqual(messagesBefore);
	});

	it("fails immediately on non-retryable 403 permission errors without retrying", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "403 Forbidden: Consumer Terms of Service have not been accepted",
			}),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);

		await expect(harness.session.compact()).rejects.toThrow(
			"Summarization failed: 403 Forbidden: Consumer Terms of Service have not been accepted",
		);

		expect(getCallCount()).toBe(1);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
	});

	it("fails immediately on the 400 Consumer Terms wording from the production report", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedSplitTurnSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const historySummary: AssistantMessage = {
			...fauxAssistantMessage("history summary"),
			usage: createUsage(10),
		};
		const prefixError: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '400 {"error":{"message":"Consumer Terms must be accepted"}}',
			}),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [historySummary, prefixError]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		// History call + exactly one prefix call: the 400 is never retried.
		expect(getCallCount()).toBe(2);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			'Auto-compaction failed: Turn prefix summarization failed: 400 {"error":{"message":"Consumer Terms must be accepted"}}',
		);
	});

	it("replaces messages with summary plus kept tail after a successful auto-compaction and does not immediately retrigger", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		// A history large enough that the threshold check must compact it.
		const now = Date.now();
		const filler = "x".repeat(4000);
		for (let i = 0; i < 8; i++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `${filler} ${i}` }],
				timestamp: now - 10_000 + i * 100,
			});
			const assistant = createAssistant(harness, {
				stopReason: "stop",
				totalTokens: 0,
				timestamp: now - 9_000 + i * 100,
			});
			assistant.content = [{ type: "text", text: `${filler} reply ${i}` }];
			harness.sessionManager.appendMessage(assistant);
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const summary: AssistantMessage = {
			...fauxAssistantMessage("auto summary of the history"),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [summary]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const messagesBefore = harness.session.agent.state.messages.length;
		const tokensBefore = harness.session.agent.state.messages.reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);

		await sessionInternals._runAutoCompaction("threshold", false);

		// Split turn: one history summary call + one turn prefix summary call.
		expect(getCallCount()).toBe(2);
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({ reason: "threshold", aborted: false });

		// The agent state was rebuilt: [compactionSummary + kept tail].
		const messagesAfter = harness.session.agent.state.messages;
		expect(messagesAfter.length).toBeLessThan(messagesBefore);
		expect(messagesAfter[0]?.role).toBe("compactionSummary");
		const rebuiltTokens = messagesAfter.reduce((sum, message) => sum + estimateTokens(message), 0);
		expect(rebuiltTokens).toBeLessThan(tokensBefore);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBe(rebuiltTokens);

		// The next threshold check sees the shrunk context and stays quiet.
		const freshAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: estimateContextTokens(messagesAfter).tokens,
			timestamp: Date.now() + 1000,
		});
		const startsBefore = harness.eventsOfType("compaction_start").length;
		await expect(sessionInternals._checkCompaction(freshAssistant, false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(startsBefore);
	});
});
