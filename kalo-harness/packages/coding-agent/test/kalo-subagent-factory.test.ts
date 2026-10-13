import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { childSessionDir, lookup, resetRegistry } from "../src/extensions/subagent/children.ts";
import { createChild, reviveChild } from "../src/extensions/subagent/runner.ts";
import { CHILD_TOOLS_ENTRY } from "../src/extensions/subagent/tools.ts";

const state = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("../src/config.ts", async (original) => ({ ...(await original<object>()), getAgentDir: () => state.agentDir }));
vi.mock("../src/core/sdk.ts", () => ({ createAgentSession: vi.fn() }));
vi.mock("../src/core/model-runtime.ts", () => ({ ModelRuntime: { create: vi.fn(async () => ({})) } }));
vi.mock("../src/core/resource-loader.ts", () => ({
	DefaultResourceLoader: class {
		async reload() {}
	},
}));
vi.mock("../src/core/settings-manager.ts", () => ({ SettingsManager: { create: () => ({}) } }));

const dirs: string[] = [];
afterEach(() => {
	resetRegistry();
	vi.clearAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(actualTools?: string[]) {
	state.agentDir = mkdtempSync(join(tmpdir(), "subagent-factory-"));
	dirs.push(state.agentDir);
	let manager!: SessionManager;
	const dispose = vi.fn();
	vi.mocked(createAgentSession).mockImplementation(async (options) => {
		manager = options!.sessionManager!;
		const session = {
			sessionManager: manager,
			getActiveToolNames: () => actualTools ?? options!.tools ?? [],
			dispose,
			agent: { state: { messages: [] } },
		} as unknown as AgentSession;
		return { session } as Awaited<ReturnType<typeof createAgentSession>>;
	});
	const options = {
		cwd: state.agentDir,
		parentSessionId: "owner",
		childId: "subagent-7",
		model: undefined,
		thinkingLevel: undefined,
		tools: ["read"],
	};
	const directory = childSessionDir(options.cwd, options.parentSessionId, state.agentDir);
	return { options, directory, dispose, manager: () => manager };
}
function seed(directory: string, customTools?: string[]) {
	mkdirSync(directory, { recursive: true });
	const entries: unknown[] = [
		{ type: "session", version: 3, id: "subagent-7", cwd: state.agentDir, timestamp: new Date().toISOString() },
	];
	if (customTools)
		entries.push({
			type: "custom",
			id: "tools",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: CHILD_TOOLS_ENTRY,
			data: { tools: customTools },
		});
	writeFileSync(
		join(directory, "2026_subagent-7.jsonl"),
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}

describe("child creation and revival permissions", () => {
	it("persists actual tools before registering a new resident", async () => {
		const f = setup();
		const child = await createChild(f.options);
		expect(child.tools).toEqual(["read"]);
		expect(JSON.parse(readFileSync(join(f.directory, "subagent-7.tools.json"), "utf8")).tools).toEqual(["read"]);
		expect(f.manager().getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ customType: CHILD_TOOLS_ENTRY, data: { tools: ["read"] } }),
			]),
		);
	});
	it("rejects unavailable tools before registering or prompting", async () => {
		const f = setup([]);
		await expect(createChild(f.options)).rejects.toThrow("实际工具");
		expect(lookup("subagent-7", "owner")).toBeUndefined();
		expect(f.dispose).toHaveBeenCalledOnce();
	});
	it("revives persisted initial permissions instead of request permissions", async () => {
		const f = setup();
		await createChild(f.options);
		resetRegistry();
		seed(f.directory);
		const child = await reviveChild({ ...f.options, tools: ["bash", "write"] });
		expect(child.tools).toEqual(["read"]);
		expect(vi.mocked(createAgentSession).mock.lastCall?.[0]?.tools).toEqual(["read"]);
	});
	it("revives legacy custom metadata and defaults unrecorded legacy sessions to no tools", async () => {
		const f = setup();
		seed(f.directory, ["grep"]);
		expect((await reviveChild({ ...f.options, tools: ["bash"] })).tools).toEqual(["grep"]);
		resetRegistry();
		seed(f.directory);
		expect((await reviveChild({ ...f.options, tools: ["bash"] })).tools).toEqual([]);
	});
});
