import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AskUserAnswer,
	AskUserRequest,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/index.ts";
import { AskUserError } from "../src/extensions/ask-user/errors.ts";
import askUserExtension from "../src/extensions/ask-user/index.ts";

type AskFn = (request: AskUserRequest) => Promise<AskUserAnswer>;

/** Load the extension and hand back the registered tool (or undefined). */
function load(options: { ask?: AskFn } = {}) {
	const tools: ToolDefinition[] = [];
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	askUserExtension(api);

	const ctx = {
		ui: options.ask === undefined ? {} : { askUser: options.ask },
	} as unknown as ExtensionContext;

	return {
		tool: tools[0] as ToolDefinition | undefined,
		names: tools.map((t) => t.name),
		run(questions: unknown[], signal?: AbortSignal) {
			const tool = tools[0];
			if (!tool) throw new Error("ask_user was not registered");
			return tool.execute("call-1", { questions } as never, signal, undefined, ctx);
		},
	};
}

const OPTIONS = [{ label: "改 A" }, { label: "改 B" }];

afterEach(() => {
	delete process.env.KALO_UNATTENDED;
});

describe("ask_user registration", () => {
	it("registers the tool for an attended run", () => {
		expect(load().names).toEqual(["ask_user"]);
	});

	it("does not register the tool when the run is unattended", () => {
		process.env.KALO_UNATTENDED = "1";
		expect(load().names).toEqual([]);
	});

	it("runs serially so two questions never contend for the input area", () => {
		expect(load().tool?.executionMode).toBe("sequential");
	});

	it("declares a prompt snippet so it appears in the system prompt tool list", () => {
		expect(load().tool?.promptSnippet).toContain("ask_user");
	});
});

describe("ask_user execution", () => {
	it("passes questions through in the seam's camelCase vocabulary", async () => {
		const seen: AskUserRequest[] = [];
		const ask = vi.fn(async (request: AskUserRequest): Promise<AskUserAnswer> => {
			seen.push(request);
			return { answers: [{ id: "q1", selected: ["改 A"] }] };
		});
		const { run } = load({ ask });

		await run([{ id: " q1 ", question: "改哪个？", options: OPTIONS, multi_select: true }]);

		expect(ask).toHaveBeenCalledTimes(1);
		expect(seen[0].questions).toEqual([{ id: "q1", question: "改哪个？", options: OPTIONS, multiSelect: true }]);
	});

	it("returns the answers as JSON content plus questions in details", async () => {
		const answers = [{ id: "q1", selected: ["改 B"], custom: undefined }].map(({ id, selected }) => ({
			id,
			selected,
		}));
		const { run } = load({ ask: async () => ({ answers }) });

		const result = await run([{ id: "q1", question: "改哪个？", options: OPTIONS }]);

		expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ answers }) }]);
		const details = result.details as { questions: unknown[]; answers: unknown[] };
		expect(details.answers).toEqual(answers);
		expect(details.questions).toHaveLength(1);
	});

	it("rejects an invalid batch before reaching the channel", async () => {
		const ask = vi.fn(async (_request: AskUserRequest): Promise<AskUserAnswer> => ({ answers: [] }));
		const { run } = load({ ask });

		await expect(run([])).rejects.toThrow("至少 1 个");
		expect(ask).not.toHaveBeenCalled();
	});

	it("fails with NO_ASK_CHANNEL when the surface cannot ask", async () => {
		const { run } = load();
		await expect(run([{ id: "q1", question: "改哪个？", options: OPTIONS }])).rejects.toThrow("NO_ASK_CHANNEL");
	});

	it("tells the model to stop re-asking after ASK_CANCELLED", async () => {
		const { run } = load({
			ask: async () => {
				throw new AskUserError("ASK_CANCELLED", "用户关闭了提问");
			},
		});

		await expect(run([{ id: "q1", question: "改哪个？", options: OPTIONS }])).rejects.toThrow(
			/ASK_CANCELLED[\s\S]*不要重新提问/,
		);
	});

	it("distinguishes an aborted turn from a cancelled ask", async () => {
		const { run } = load({
			ask: async () => {
				throw new AskUserError("ASK_ABORTED", "本轮被中止");
			},
		});

		const err = await run([{ id: "q1", question: "改哪个？", options: OPTIONS }]).catch((e: Error) => e);
		expect(String(err)).toContain("ASK_ABORTED");
		expect(String(err)).not.toContain("不要重新提问");
	});

	it("surfaces a bad answer batch as BAD_ANSWER", async () => {
		const { run } = load({
			ask: async () => {
				throw new AskUserError("BAD_ANSWER", "期望 1 条答案，收到 0 条");
			},
		});

		await expect(run([{ id: "q1", question: "改哪个？", options: OPTIONS }])).rejects.toThrow("BAD_ANSWER");
	});

	it("forwards the turn's abort signal to the channel", async () => {
		const controller = new AbortController();
		const seen: AskUserRequest[] = [];
		const ask = async (request: AskUserRequest): Promise<AskUserAnswer> => {
			seen.push(request);
			return { answers: [{ id: "q1", selected: [] }] };
		};
		const { run } = load({ ask });

		await run([{ id: "q1", question: "改哪个？", options: OPTIONS }], controller.signal);

		expect(seen[0].signal).toBe(controller.signal);
	});
});
