/**
 * Session namer — gives every session a short human title after its first turn.
 *
 * Without this, nothing ever writes a `session_info` entry, so session pickers
 * (pi's own selector, the Kalo desktop sidebar and title bar) fall back to the
 * raw first user message and every row reads like a wall of prompt text.
 *
 * One shot per session: after the first turn settles we ask the current model
 * for a 10–16 character title and write it with `pi.setSessionName()`, which
 * appends a `session_info` entry and broadcasts `session_info_changed` — the
 * clients already listen for that, so nothing downstream needs to change.
 *
 * Naming is decoration, never a requirement: every failure path silently gives
 * up and leaves the fallback title in place. In particular a manual rename
 * always wins — we skip if the session is already named, and re-check right
 * before writing in case the user renamed while the request was in flight.
 *
 * Design: doc/2026-08-21-会话自动命名.md
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";

/** Hard cap on the generated title, after sanitizing. */
const MAX_TITLE_CHARS = 24;
/** Per-message material fed to the namer. Enough to tell what the session is about. */
const MAX_MATERIAL_CHARS = 600;
/**
 * Response cap. Deliberately far larger than a title: on reasoning models the
 * thinking tokens come out of this same budget, and a model whose catalog entry
 * lacks reasoning config (a hand-written `models.json` override, say) gets no
 * `thinking: disabled` parameter at all, so it may burn a thousand-plus tokens
 * thinking before writing a word. A tight cap here doesn't produce a short
 * title — it produces an empty one. `MAX_TITLE_CHARS` is what bounds length.
 */
const MAX_RESPONSE_TOKENS = 2048;
/**
 * Give up on a slow provider rather than keep a request open for the whole
 * session. Generous because a reasoning model may think for a while before
 * emitting the title (see {@link MAX_RESPONSE_TOKENS}); nobody is waiting on
 * this request, so a late title still beats no title.
 */
const REQUEST_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT =
	"你为一段对话取标题。只输出标题本身，不要引号、书名号、句号，不要任何前缀或解释。" +
	"标题 10-16 个字，概括这段对话要做的事，用对话所用的语言（中文对话就写中文）。";

/**
 * Sessions we've already named (or are naming right now). Keyed on the session
 * manager so a `/new` session gets its own chance, and so nothing is retained
 * after the session object is dropped.
 */
const handled = new WeakSet<object>();

/**
 * LLM output is untrusted: it may arrive quoted, prefixed with "标题：", padded
 * with newlines, or simply be a whole paragraph. Strip all of that and cap the
 * length. Returns "" when nothing usable is left — callers must then give up
 * rather than write an empty name (an empty `session_info` clears the title).
 */
export function sanitizeTitle(raw: string): string {
	let title = raw.replace(/\s+/g, " ").trim();
	// A chatty model puts the title on its own line after a preamble; keep the last line.
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length > 1) title = lines[lines.length - 1].replace(/\s+/g, " ").trim();
	title = title.replace(/^(标题|title)\s*[:：]\s*/i, "");
	// Paired wrappers the model adds despite being told not to.
	title = title.replace(/^["'“”‘’「」『』《》〈〉]+/, "").replace(/["'“”‘’「」『』《》〈〉]+$/, "");
	title = title.replace(/[。．.!！?？,，;；:：、\s]+$/, "");
	return title.slice(0, MAX_TITLE_CHARS).trim();
}

/** Text of a message entry, or "" for entries that carry no text. */
function entryText(entry: SessionEntry, role: "user" | "assistant"): string {
	if (entry.type !== "message" || entry.message.role !== role) return "";
	const content = (entry.message as { content?: unknown }).content;
	if (typeof content !== "string" && !Array.isArray(content)) return "";
	return contentText(content as string | (TextContent | ImageContent)[]).trim();
}

/**
 * First user prompt plus the first assistant reply. The reply matters: a
 * two-word prompt ("继续", "看看这个") says nothing on its own, but what the
 * assistant did with it usually names the session precisely.
 */
function collectMaterial(entries: SessionEntry[]): { prompt: string; reply: string; userMessages: number } {
	let prompt = "";
	let reply = "";
	let userMessages = 0;
	for (const entry of entries) {
		const user = entryText(entry, "user");
		if (user) {
			userMessages++;
			if (!prompt) prompt = user.slice(0, MAX_MATERIAL_CHARS);
			continue;
		}
		if (!reply) {
			const assistant = entryText(entry, "assistant");
			if (assistant) reply = assistant.slice(0, MAX_MATERIAL_CHARS);
		}
	}
	return { prompt, reply, userMessages };
}

/** Ask the model for a title. Returns "" on any non-usable response. */
async function requestTitle(ctx: ExtensionContext, prompt: string, reply: string): Promise<string> {
	const model = ctx.model;
	if (!model) return "";

	let text = `<user-message>\n${prompt}\n</user-message>`;
	if (reply) text += `\n\n<assistant-reply>\n${reply}\n</assistant-reply>`;
	text += "\n\n为这段对话取一个标题。";

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
		},
		{
			maxTokens: MAX_RESPONSE_TOKENS,
			// Standalone one-off request: don't pay to write a cache entry nothing will reuse.
			cacheRetention: "none",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") return "";
	return sanitizeTitle(contentText(response.content));
}

/** Decide whether this settle is the one that should name the session. */
function shouldName(ctx: ExtensionContext, userMessages: number): boolean {
	if (!ctx.model) return false;
	// A name already exists (manual rename, or a resumed session) — never overwrite.
	if (ctx.sessionManager.getSessionName()?.trim()) return false;
	// Only the first turn. Later settles would rename a session the user has
	// already learned to recognize by its title.
	return userMessages === 1;
}

export default function sessionNamerExtension(pi: ExtensionAPI): void {
	pi.on("agent_settled", (_event, ctx) => {
		const key = ctx.sessionManager as unknown as object;
		if (handled.has(key)) return;

		const { prompt, reply, userMessages } = collectMaterial(ctx.sessionManager.buildContextEntries());
		if (!prompt || !shouldName(ctx, userMessages)) return;

		handled.add(key);
		// Fire-and-forget: `agent_settled` handlers are awaited, so blocking here
		// would hold up the run's settle — and with it RPC shutdown checks and
		// the desktop usage footer — for the length of an LLM round trip.
		void (async () => {
			try {
				const title = await requestTitle(ctx, prompt, reply);
				// Nothing usable: leave the fallback title alone. Writing "" would
				// actively clear the name.
				if (!title) return;
				// The user may have renamed while we were waiting; theirs wins.
				if (ctx.sessionManager.getSessionName()?.trim()) return;
				pi.setSessionName(title);
			} catch {
				// Provider errors, timeouts, and `assertActive()` throwing after the
				// session was replaced (/new, fork, switch) all land here. A session
				// without a generated title is fine; a session that crashed while
				// naming itself is not.
			}
		})();
	});
}
