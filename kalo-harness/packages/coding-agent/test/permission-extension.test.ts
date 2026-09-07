import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import permissionExtension from "../src/extensions/permission/index.ts";
import { foldGrants, foldMode } from "../src/extensions/permission/state.ts";
import type { PermissionMode } from "../src/extensions/permission/types.ts";
import { GRANT_ENTRY_TYPE, MODE_ENTRY_TYPE } from "../src/extensions/permission/types.ts";

type ToolCallHandler = (
	event: { type: "tool_call"; toolName: string; toolCallId: string; input: Record<string, unknown> },
	ctx: ExtensionContext,
) => Promise<{ block?: boolean; reason?: string } | undefined>;
type SessionStartHandler = (event: { type: "session_start"; reason: string }, ctx: ExtensionContext) => Promise<void>;
type BeforeAgentStartHandler = (
	event: { type: "before_agent_start"; systemPrompt: string },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt?: string } | undefined>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
}

const WIN = process.platform === "win32";
const WORKSPACE = WIN ? "D:\\project\\app" : "/project/app";
const OUTSIDE = WIN ? "D:\\other\\a.ts" : "/other/a.ts";

function setup(options: { hasUI?: boolean; choice?: string; entries?: Entry[] } = {}) {
	const entries: Entry[] = [...(options.entries ?? [])];
	let toolCall: ToolCallHandler | undefined;
	let sessionStart: SessionStartHandler | undefined;
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	const commands = new Map<string, CommandHandler>();

	const appendEntry = vi.fn((customType: string, data?: unknown) => {
		entries.push({ type: "custom", customType, data });
	});

	const api = {
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: unknown) {
			if (event === "tool_call") toolCall = handler as ToolCallHandler;
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
			if (event === "before_agent_start") beforeAgentStart = handler as BeforeAgentStartHandler;
		},
		appendEntry,
	} as unknown as ExtensionAPI;

	permissionExtension(api);

	const select = vi.fn(async () => options.choice);
	const notify = vi.fn();
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: WORKSPACE,
		signal: undefined,
		ui: { select, notify },
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;

	return {
		appendEntry,
		entries,
		notify,
		select,
		async start(reason = "startup") {
			if (!sessionStart) throw new Error("Missing session_start handler");
			await sessionStart({ type: "session_start", reason }, ctx);
		},
		async call(toolName: string, input: Record<string, unknown>) {
			if (!toolCall) throw new Error("Missing tool_call handler");
			return await toolCall({ type: "tool_call", toolName, toolCallId: "c1", input }, ctx);
		},
		async prompt(base = "BASE") {
			if (!beforeAgentStart) throw new Error("Missing before_agent_start handler");
			return await beforeAgentStart({ type: "before_agent_start", systemPrompt: base }, ctx);
		},
		async command(args: string) {
			const handler = commands.get("permission");
			if (!handler) throw new Error("Missing /permission command");
			await handler(args, ctx);
		},
	};
}

function modeEntry(mode: PermissionMode): Entry {
	return { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode, source: "user" } };
}

describe("permission extension: session pinning", () => {
	it("pins the default mode into a brand-new session", async () => {
		const harness = setup();
		await harness.start("new");
		expect(harness.appendEntry).toHaveBeenCalledWith(MODE_ENTRY_TYPE, {
			mode: "workspace-write",
			source: "default",
		});
	});

	it("keeps a resumed session's recorded mode instead of the current default", async () => {
		const harness = setup({ entries: [modeEntry("read-only")], choice: "允许一次" });
		await harness.start("resume");
		expect(harness.appendEntry).not.toHaveBeenCalled();
		// A workspace write prompts, which only happens in read-only: the session
		// kept its own mode instead of adopting the workspace-write default.
		expect(await harness.call("write", { path: "src/a.ts" })).toBeUndefined();
		expect(harness.select).toHaveBeenCalledOnce();
	});

	it("restores grants recorded in the session log", async () => {
		const dir = WIN ? "D:\\other" : "/other";
		const harness = setup({
			entries: [
				modeEntry("workspace-write"),
				{ type: "custom", customType: GRANT_ENTRY_TYPE, data: { tool: "write", dir } },
			],
		});
		await harness.start("resume");
		expect(await harness.call("write", { path: OUTSIDE })).toBeUndefined();
	});
});

describe("permission extension: gating", () => {
	it("allows workspace writes in workspace-write without prompting", async () => {
		const harness = setup();
		await harness.start();
		expect(await harness.call("write", { path: "src/a.ts" })).toBeUndefined();
		expect(harness.select).not.toHaveBeenCalled();
	});

	it("prompts before a write that leaves the workspace", async () => {
		const harness = setup({ choice: "允许一次" });
		await harness.start();
		expect(await harness.call("write", { path: OUTSIDE })).toBeUndefined();
		expect(harness.select).toHaveBeenCalledOnce();
	});

	it("blocks with a model-readable reason when the user rejects", async () => {
		const harness = setup({ choice: "拒绝" });
		await harness.start();
		const decision = await harness.call("write", { path: OUTSIDE });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("rejected");
		expect(decision?.reason).toContain("Do not retry");
	});

	it("remembers a session grant so the same directory stops prompting", async () => {
		const harness = setup({ choice: "本会话允许同类" });
		await harness.start();
		const other = WIN ? "D:\\other\\b.ts" : "/other/b.ts";
		expect(await harness.call("write", { path: OUTSIDE })).toBeUndefined();
		expect(harness.appendEntry).toHaveBeenCalledWith(GRANT_ENTRY_TYPE, expect.objectContaining({ tool: "write" }));
		expect(await harness.call("write", { path: other })).toBeUndefined();
		expect(harness.select).toHaveBeenCalledOnce();
	});

	it("offers no session grant in read-only mode", async () => {
		const harness = setup({ entries: [modeEntry("read-only")], choice: "允许一次" });
		await harness.start("resume");
		await harness.call("write", { path: "src/a.ts" });
		expect(harness.select).toHaveBeenCalledWith(expect.any(String), ["允许一次", "拒绝"], expect.anything());
	});

	it("prompts before every shell command in read-only mode", async () => {
		const harness = setup({ entries: [modeEntry("read-only")], choice: "允许一次" });
		await harness.start("resume");
		expect(await harness.call("bash", { command: "npm test" })).toBeUndefined();
		expect(harness.select).toHaveBeenCalledOnce();
	});

	it("does not prompt for shell commands in workspace-write mode", async () => {
		const harness = setup();
		await harness.start();
		expect(await harness.call("bash", { command: "npm test" })).toBeUndefined();
		expect(harness.select).not.toHaveBeenCalled();
	});

	it("refuses red-line commands without offering approval", async () => {
		const harness = setup({ entries: [modeEntry("full-auto")] });
		await harness.start("resume");
		const decision = await harness.call("bash", { command: "rm -rf /" });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("cannot be approved");
		expect(harness.select).not.toHaveBeenCalled();
	});

	it("fails closed with no UI instead of hanging", async () => {
		const harness = setup({ hasUI: false });
		await harness.start();
		const decision = await harness.call("write", { path: OUTSIDE });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("no user to ask");
		expect(harness.select).not.toHaveBeenCalled();
	});

	it("fails closed when the dialog is dismissed without an answer", async () => {
		const harness = setup({ choice: undefined });
		await harness.start();
		const decision = await harness.call("write", { path: OUTSIDE });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("cancelled");
	});
});

describe("permission extension: mode switching", () => {
	it("records the new mode and resets grants", async () => {
		const harness = setup({ choice: "本会话允许同类" });
		await harness.start();
		await harness.call("write", { path: OUTSIDE });
		expect(foldGrants(harness.entries)).toHaveLength(1);

		await harness.command("read-only");

		expect(foldMode(harness.entries)).toBe("read-only");
		expect(foldGrants(harness.entries)).toHaveLength(0);
	});

	it("is a no-op when the requested mode is already current", async () => {
		const harness = setup();
		await harness.start();
		harness.appendEntry.mockClear();
		await harness.command("workspace-write");
		expect(harness.appendEntry).not.toHaveBeenCalled();
	});

	it("reports the current mode when invoked bare", async () => {
		const harness = setup();
		await harness.start();
		await harness.command("");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("workspace-write"), "info");
	});

	it("rejects an unknown mode name", async () => {
		const harness = setup();
		await harness.start();
		await harness.command("yolo");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("未知权限模式"), "error");
		expect(foldMode(harness.entries)).toBe("workspace-write");
	});
});

describe("permission extension: model visibility", () => {
	it("appends the mode contribution after the base prompt", async () => {
		const harness = setup();
		await harness.start();
		const result = await harness.prompt("BASE");
		expect(result?.systemPrompt?.startsWith("BASE")).toBe(true);
		expect(result?.systemPrompt).toContain("Permission mode: workspace-write");
	});

	it("describes read-only as requiring per-operation approval", async () => {
		const harness = setup({ entries: [modeEntry("read-only")] });
		await harness.start("resume");
		const result = await harness.prompt();
		expect(result?.systemPrompt).toContain("per-operation approval");
	});
});

describe("permission state folding", () => {
	it("returns undefined for a session with no mode entry", () => {
		expect(foldMode([{ type: "message" }])).toBeUndefined();
	});

	it("takes the last mode entry", () => {
		expect(foldMode([modeEntry("read-only"), modeEntry("full-auto")])).toBe("full-auto");
	});

	it("ignores malformed mode entries", () => {
		const bad: Entry = { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "nonsense" } };
		expect(foldMode([modeEntry("read-only"), bad])).toBe("read-only");
	});

	it("drops grants recorded before a reset", () => {
		const grant = (dir: string): Entry => ({
			type: "custom",
			customType: GRANT_ENTRY_TYPE,
			data: { tool: "write", dir },
		});
		const reset: Entry = { type: "custom", customType: GRANT_ENTRY_TYPE, data: { reset: true } };
		expect(foldGrants([grant("/a"), reset, grant("/b")])).toEqual([{ tool: "write", dir: "/b" }]);
	});
});
