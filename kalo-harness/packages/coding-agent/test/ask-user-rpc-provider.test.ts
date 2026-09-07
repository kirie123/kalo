import { describe, expect, it } from "vitest";
import type { AskUserQuestion } from "../src/core/extensions/index.ts";
import { AskUserError } from "../src/extensions/ask-user/errors.ts";
import type { RpcAskReply } from "../src/extensions/ask-user/rpc-provider.ts";
import { createRpcAskUser } from "../src/extensions/ask-user/rpc-provider.ts";

const QUESTIONS: AskUserQuestion[] = [
	{ id: "q1", question: "改哪个？", options: [{ label: "改 A" }, { label: "改 B" }] },
];

/** A provider wired to an in-memory transport, with the sent frames captured. */
function setup() {
	const waiters = new Map<string, (reply: RpcAskReply) => void>();
	const sent: { id: string; questions: AskUserQuestion[] }[] = [];
	let nextId = 0;

	const askUser = createRpcAskUser({
		newId: () => `id-${++nextId}`,
		register: (id, onReply) => {
			waiters.set(id, onReply);
		},
		unregister: (id) => {
			waiters.delete(id);
		},
		send: (id, questions) => {
			sent.push({ id, questions });
		},
	});

	return {
		askUser,
		sent,
		pendingCount: () => waiters.size,
		/** Deliver a client reply the way the RPC layer does: drop the entry, then call. */
		reply(id: string, reply: RpcAskReply) {
			const onReply = waiters.get(id);
			waiters.delete(id);
			onReply?.(reply);
		},
	};
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	const err = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(AskUserError);
	return (err as AskUserError).code;
}

describe("RPC askUser provider", () => {
	it("sends one request frame and resolves with the validated answers", async () => {
		const { askUser, sent, reply } = setup();
		const promise = askUser({ questions: QUESTIONS });

		expect(sent).toEqual([{ id: "id-1", questions: QUESTIONS }]);
		reply("id-1", { answers: [{ id: "q1", selected: ["改 A"] }] });

		await expect(promise).resolves.toEqual({ answers: [{ id: "q1", selected: ["改 A"] }] });
	});

	it("rejects ASK_CANCELLED when the user dismissed the request", async () => {
		const { askUser, reply } = setup();
		const promise = askUser({ questions: QUESTIONS });
		reply("id-1", { cancelled: true });

		expect(await codeOf(promise)).toBe("ASK_CANCELLED");
	});

	it("rejects BAD_ANSWER when the reply has no answers array", async () => {
		const { askUser, reply } = setup();
		const promise = askUser({ questions: QUESTIONS });
		reply("id-1", {});

		expect(await codeOf(promise)).toBe("BAD_ANSWER");
	});

	it("rejects BAD_ANSWER when the batch does not fit the questions", async () => {
		const { askUser, reply } = setup();
		const promise = askUser({ questions: QUESTIONS });
		reply("id-1", { answers: [{ id: "q1", selected: ["改 C"] }] });

		expect(await codeOf(promise)).toBe("BAD_ANSWER");
	});

	it("rejects ASK_ABORTED without sending anything when the signal is already aborted", async () => {
		const { askUser, sent } = setup();
		const promise = askUser({ questions: QUESTIONS, signal: AbortSignal.abort() });

		expect(await codeOf(promise)).toBe("ASK_ABORTED");
		expect(sent).toEqual([]);
	});

	it("rejects ASK_ABORTED and drops the waiter when the turn is aborted mid-wait", async () => {
		const controller = new AbortController();
		const { askUser, pendingCount } = setup();
		const promise = askUser({ questions: QUESTIONS, signal: controller.signal });

		expect(pendingCount()).toBe(1);
		controller.abort();

		expect(await codeOf(promise)).toBe("ASK_ABORTED");
		expect(pendingCount()).toBe(0);
	});

	it("keeps the first settlement when an answer arrives after an abort", async () => {
		const controller = new AbortController();
		const { askUser, reply } = setup();
		const promise = askUser({ questions: QUESTIONS, signal: controller.signal });

		controller.abort();
		// A late answer must not overwrite the abort, and must not throw.
		reply("id-1", { answers: [{ id: "q1", selected: ["改 A"] }] });

		expect(await codeOf(promise)).toBe("ASK_ABORTED");
	});

	it("ignores a duplicate reply after the answer was accepted", async () => {
		const { askUser, reply, pendingCount } = setup();
		const promise = askUser({ questions: QUESTIONS });

		reply("id-1", { answers: [{ id: "q1", selected: ["改 A"] }] });
		reply("id-1", { cancelled: true });

		await expect(promise).resolves.toEqual({ answers: [{ id: "q1", selected: ["改 A"] }] });
		expect(pendingCount()).toBe(0);
	});

	it("gives each request its own correlation id", async () => {
		const { askUser, sent, reply } = setup();
		const first = askUser({ questions: QUESTIONS });
		const second = askUser({ questions: QUESTIONS });

		expect(sent.map((frame) => frame.id)).toEqual(["id-1", "id-2"]);
		reply("id-2", { answers: [{ id: "q1", selected: ["改 B"] }] });
		reply("id-1", { answers: [{ id: "q1", selected: ["改 A"] }] });

		await expect(second).resolves.toEqual({ answers: [{ id: "q1", selected: ["改 B"] }] });
		await expect(first).resolves.toEqual({ answers: [{ id: "q1", selected: ["改 A"] }] });
	});
});
