import type { AgentContext, PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression: a mid-run compaction must reach the agent loop.
 *
 * The loop runs on a context snapshot taken when the run started, so shrinking
 * `agent.state.messages` during the run is invisible to it. `prepareNextTurn`
 * is the only seam that can swap that snapshot; it used to refresh the system
 * prompt and tools but keep the caller's (pre-compaction) message list. The
 * next request therefore carried the full history again, the threshold check
 * fired once more, and each pass appended another summary — an observed
 * session compacted 9 times in 8 minutes with tokensBefore climbing 183655 →
 * 190324 while cacheRead never dropped.
 */

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

/** Answer the summarization request with a short, cheap summary. */
function useSummaryStreamFn(harness: Harness, summary: string): void {
	harness.session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage(summary),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				},
			});
		});
		return stream;
	};
}

/** A history big enough that the threshold check must compact it. */
function seedOversizedSession(harness: Harness): AssistantMessage {
	const model = harness.getModel();
	const now = Date.now();
	const filler = "x".repeat(4000);

	for (let i = 0; i < 12; i++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${filler} ${i}` }],
			timestamp: now - 10_000 + i * 100,
		});
		const assistant: AssistantMessage = {
			...fauxAssistantMessage(`${filler} reply ${i}`, { stopReason: "stop", timestamp: now - 9_000 + i * 100 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(0),
		};
		harness.sessionManager.appendMessage(assistant);
	}

	const last: AssistantMessage = {
		...fauxAssistantMessage("latest", { stopReason: "toolUse", timestamp: now }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		// Reported context sits above the compaction threshold for this model.
		usage: createUsage(Math.floor(model.contextWindow * 0.95)),
	};
	harness.sessionManager.appendMessage(last);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return last;
}

describe("compaction reaches the agent loop's next turn", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("hands the compacted history to the next turn instead of the stale snapshot", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		useSummaryStreamFn(harness, "summary of the compacted history");

		const lastAssistant = seedOversizedSession(harness);
		// The snapshot the loop is holding: the full, pre-compaction history.
		const staleContext: AgentContext = {
			systemPrompt: "test",
			messages: harness.session.agent.state.messages.slice(),
			tools: harness.session.agent.state.tools.slice(),
		};
		const messagesBefore = staleContext.messages.length;

		const prepareNextTurn = harness.session.agent.prepareNextTurnWithContext;
		expect(prepareNextTurn).toBeDefined();

		const turn: PrepareNextTurnContext = {
			message: lastAssistant,
			toolResults: [],
			context: staleContext,
			newMessages: [],
		};
		const update = await prepareNextTurn?.(turn);

		// Compaction ran: state was rebuilt and is shorter than what the loop held.
		expect(harness.session.agent.state.messages.length).toBeLessThan(messagesBefore);

		// The seam must hand that rebuilt list back, or the next request repeats
		// the full history and compaction loops.
		expect(update?.context?.messages).toEqual(harness.session.agent.state.messages);
		expect(update?.context?.messages.length).toBeLessThan(messagesBefore);
		expect(update?.context?.messages.some((m) => m.role === "compactionSummary")).toBe(true);
	});

	it("keeps the caller's messages when no compaction happened", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);

		const model = harness.getModel();
		const small: AssistantMessage = {
			...fauxAssistantMessage("small", { stopReason: "toolUse", timestamp: Date.now() }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(10),
		};
		harness.sessionManager.appendMessage(small);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// Messages the loop appended this turn that are not in agent state yet:
		// overwriting them with agent state would silently drop the turn.
		const loopMessages = [
			...harness.session.agent.state.messages,
			{ role: "user" as const, content: [{ type: "text" as const, text: "mid-loop" }], timestamp: Date.now() },
		];
		const context: AgentContext = {
			systemPrompt: "test",
			messages: loopMessages,
			tools: harness.session.agent.state.tools.slice(),
		};

		const update = await harness.session.agent.prepareNextTurnWithContext?.({
			message: small,
			toolResults: [],
			context,
			newMessages: [],
		});

		expect(update?.context?.messages).toEqual(loopMessages);
	});
});
