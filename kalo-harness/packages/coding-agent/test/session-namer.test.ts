/**
 * Session namer: title sanitizing and the "should we name this session" gate.
 *
 * The naming request itself is stubbed — what matters here is that we only
 * fire once, only on the first turn, never over a name the user chose, and
 * never write garbage (or an empty string, which would clear the title).
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import sessionNamerExtension, { sanitizeTitle } from "../src/extensions/session-namer/index.ts";

function messageEntry(id: string, role: "user" | "assistant", text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-21T00:00:00Z",
		message: { role, content: [{ type: "text", text }], timestamp: 0 },
	} as unknown as SessionEntry;
}

interface Harness {
	/** Fire `agent_settled` and drain the detached naming task. */
	settle(): Promise<void>;
	/** Prompts sent to the namer model. */
	completions: string[];
	/** Titles written through `pi.setSessionName()`. */
	names: string[];
	/** Simulate a manual rename. */
	rename(name: string): void;
	sessionName(): string | undefined;
}

function harness(options: {
	entries: SessionEntry[];
	/** Raw model output for the default stub. */
	reply?: string;
	/** Present-but-undefined means "no model configured". */
	model?: unknown;
	initialName?: string;
	complete?: (context: { messages: { content: { text: string }[] }[] }) => Promise<unknown>;
}): Harness {
	let name = options.initialName;
	const names: string[] = [];
	const completions: string[] = [];

	const complete = async (_model: unknown, context: { messages: { content: { text: string }[] }[] }) => {
		completions.push(context.messages[0].content[0].text);
		if (options.complete) return options.complete(context);
		return { stopReason: "stop", content: [{ type: "text", text: options.reply ?? "修复标题解析" }] };
	};

	const ctx = {
		model: "model" in options ? options.model : { id: "test-model", provider: "test" },
		modelRegistry: { complete },
		sessionManager: {
			buildContextEntries: () => options.entries,
			getSessionName: () => name,
		},
	} as unknown as ExtensionContext;

	let handler: ExtensionHandler<{ type: "agent_settled" }> | undefined;
	const pi = {
		on: (event: string, h: ExtensionHandler<{ type: "agent_settled" }>) => {
			if (event === "agent_settled") handler = h;
		},
		setSessionName: (n: string) => {
			names.push(n);
			name = n;
		},
	} as unknown as ExtensionAPI;

	sessionNamerExtension(pi);

	const self: Harness = {
		async settle() {
			await handler?.({ type: "agent_settled" }, ctx);
			// The naming task is deliberately not awaited by the handler; give it a
			// macrotask to finish before asserting.
			await new Promise((resolve) => setImmediate(resolve));
		},
		completions,
		names,
		rename(n: string) {
			name = n;
		},
		sessionName: () => name,
	};
	return self;
}

const FIRST_TURN = [
	messageEntry("m1", "user", "帮我把会话标题接上"),
	messageEntry("m2", "assistant", "好的，我先看代码"),
];

describe("sanitizeTitle", () => {
	it("strips wrapping quotes and book-title marks", () => {
		expect(sanitizeTitle('"修复标题解析"')).toBe("修复标题解析");
		expect(sanitizeTitle("《会话自动命名》")).toBe("会话自动命名");
		expect(sanitizeTitle("「接上标题链路」")).toBe("接上标题链路");
	});

	it("drops a label prefix and trailing punctuation", () => {
		expect(sanitizeTitle("标题：会话自动命名。")).toBe("会话自动命名");
		expect(sanitizeTitle("Title: Fix session titles!")).toBe("Fix session titles");
	});

	it("collapses whitespace and keeps the last line of a chatty answer", () => {
		expect(sanitizeTitle("修复  标题\t解析")).toBe("修复 标题 解析");
		expect(sanitizeTitle("好的，标题如下：\n会话自动命名")).toBe("会话自动命名");
	});

	it("truncates to 24 characters", () => {
		expect(sanitizeTitle("一".repeat(40))).toHaveLength(24);
	});

	it("returns empty for input with nothing usable", () => {
		expect(sanitizeTitle("")).toBe("");
		expect(sanitizeTitle("   \n  ")).toBe("");
		expect(sanitizeTitle('""')).toBe("");
	});
});

describe("session-namer", () => {
	it("names the session after the first turn", async () => {
		const h = harness({ entries: FIRST_TURN });
		await h.settle();
		expect(h.names).toEqual(["修复标题解析"]);
		// Both the prompt and the assistant reply are given to the namer.
		expect(h.completions[0]).toContain("帮我把会话标题接上");
		expect(h.completions[0]).toContain("好的，我先看代码");
	});

	it("names at most once per session", async () => {
		const h = harness({ entries: FIRST_TURN });
		await h.settle();
		await h.settle();
		expect(h.names).toEqual(["修复标题解析"]);
	});

	it("never overwrites an existing name", async () => {
		const h = harness({ entries: FIRST_TURN, initialName: "手工标题" });
		await h.settle();
		expect(h.names).toEqual([]);
		expect(h.completions).toEqual([]);
		expect(h.sessionName()).toBe("手工标题");
	});

	it("skips later turns", async () => {
		const h = harness({
			entries: [...FIRST_TURN, messageEntry("m3", "user", "继续"), messageEntry("m4", "assistant", "好")],
		});
		await h.settle();
		expect(h.names).toEqual([]);
	});

	it("skips when no model is configured", async () => {
		const h = harness({ entries: FIRST_TURN, model: undefined });
		await h.settle();
		expect(h.names).toEqual([]);
	});

	it("skips when there is no user message yet", async () => {
		const h = harness({ entries: [messageEntry("m1", "assistant", "你好")] });
		await h.settle();
		expect(h.names).toEqual([]);
	});

	it("keeps the fallback title when the model returns nothing usable", async () => {
		const h = harness({ entries: FIRST_TURN, reply: '  ""  ' });
		await h.settle();
		expect(h.names).toEqual([]);
	});

	it("keeps the fallback title when the model errors out", async () => {
		const h = harness({
			entries: FIRST_TURN,
			complete: async () => ({ stopReason: "error", content: [], errorMessage: "boom" }),
		});
		await h.settle();
		expect(h.names).toEqual([]);
	});

	it("takes the title from a response that also carries thinking blocks", async () => {
		// Reasoning models spend the response budget on thinking first. The
		// budget must be big enough that the title still lands (regression: a
		// 64-token cap left nothing but thinking, so every session went unnamed).
		const h = harness({
			entries: FIRST_TURN,
			complete: async () => ({
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "用户想要一个标题，概括这段对话……" },
					{ type: "text", text: "接上会话标题链路" },
				],
			}),
		});
		await h.settle();
		expect(h.names).toEqual(["接上会话标题链路"]);
	});

	it("still uses a title that was truncated by the token cap", async () => {
		const h = harness({
			entries: FIRST_TURN,
			complete: async () => ({ stopReason: "length", content: [{ type: "text", text: "接上会话标题" }] }),
		});
		await h.settle();
		expect(h.names).toEqual(["接上会话标题"]);
	});

	it("swallows request failures instead of breaking the settle", async () => {
		const h = harness({
			entries: FIRST_TURN,
			complete: async () => {
				throw new Error("no API key");
			},
		});
		await expect(h.settle()).resolves.toBeUndefined();
		expect(h.names).toEqual([]);
	});

	it("discards the generated title if the user renamed mid-flight", async () => {
		let h: Harness;
		h = harness({
			entries: FIRST_TURN,
			complete: async () => {
				h.rename("赶在前面的手工标题");
				return { stopReason: "stop", content: [{ type: "text", text: "自动标题" }] };
			},
		});
		await h.settle();
		expect(h.names).toEqual([]);
		expect(h.sessionName()).toBe("赶在前面的手工标题");
	});
});
