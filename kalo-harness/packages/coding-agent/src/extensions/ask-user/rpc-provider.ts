/**
 * The askUser provider over the RPC extension-UI channel.
 *
 * Split out of rpc-mode so the settlement rules — which non-answer maps to
 * which error code, and who wins when two responses race — are testable
 * without booting the whole stdin/stdout loop. The transport itself is injected
 * (`RpcAskDeps`), so this module holds only the rules.
 *
 * Deliberately NOT built on rpc-mode's createDialogPromise: that helper
 * resolves to a default value on cancel/timeout/abort, which is right for a
 * confirmation dialog and wrong here — a made-up answer to "which of these
 * should I delete" gets acted on. Every non-answer is a rejection with its own
 * code instead, and there is no timeout: waiting for a human who stepped away
 * is correct behaviour, and the turn's abort signal is how waiting ends.
 */

import type { AskUserAnswer, AskUserQuestion, AskUserRequest } from "../../core/extensions/types.ts";
import { AskUserError } from "./errors.ts";
import { validateAnswers } from "./validate.ts";

/** The client's reply to one ask request, as it arrives on the wire. */
export type RpcAskReply = { answers?: unknown; cancelled?: true };

/** What this provider needs from the RPC layer. */
export interface RpcAskDeps {
	/** Fresh correlation id for one request. */
	newId(): string;
	/** Park a waiter under `id`; the RPC layer calls `onReply` when the client answers. */
	register(id: string, onReply: (reply: RpcAskReply) => void): void;
	/** Drop the waiter for `id` (settled or withdrawn). */
	unregister(id: string): void;
	/** Emit the request frame to the client. */
	send(id: string, questions: AskUserQuestion[]): void;
}

/**
 * Build the `ctx.ui.askUser` implementation for RPC mode.
 *
 * @param deps Transport hooks owned by the RPC layer.
 * @returns The seam function: resolves with a validated answer batch, or
 *   rejects with an {@link AskUserError}.
 */
export function createRpcAskUser(deps: RpcAskDeps): (request: AskUserRequest) => Promise<AskUserAnswer> {
	return function askUser(request: AskUserRequest): Promise<AskUserAnswer> {
		const signal = request.signal;
		if (signal?.aborted) {
			return Promise.reject(new AskUserError("ASK_ABORTED", "提问发起前本轮已中止"));
		}

		const id = deps.newId();
		return new Promise<AskUserAnswer>((resolve, reject) => {
			// First settlement wins. The flag is the guard rather than the
			// registry entry, because the RPC layer removes the entry before
			// invoking the reply handler; unregistering here is what makes a
			// duplicate or late reply find no waiter at all.
			let settled = false;
			const claim = (): boolean => {
				if (settled) return false;
				settled = true;
				deps.unregister(id);
				signal?.removeEventListener("abort", onAbort);
				return true;
			};
			const onAbort = (): void => {
				if (claim()) reject(new AskUserError("ASK_ABORTED", "本轮被中止"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			deps.register(id, (reply: RpcAskReply) => {
				if (!claim()) return;
				if (reply.cancelled === true) {
					reject(new AskUserError("ASK_CANCELLED", "用户关闭了提问"));
					return;
				}
				if (!Array.isArray(reply.answers)) {
					reject(new AskUserError("BAD_ANSWER", "应答里没有 answers 数组"));
					return;
				}
				const answers = reply.answers as AskUserAnswer["answers"];
				const invalid = validateAnswers(request.questions, answers);
				if (invalid !== undefined) {
					reject(new AskUserError("BAD_ANSWER", invalid));
					return;
				}
				resolve({ answers });
			});
			deps.send(id, request.questions);
		});
	};
}
