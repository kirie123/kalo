import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { type BackgroundTaskRecord, backgroundTasks } from "../src/extensions/subagent/background.ts";
import { type ChildHandle, childSessionDir, register, resetRegistry } from "../src/extensions/subagent/children.ts";
import { childSlots } from "../src/extensions/subagent/concurrency.ts";
import { executeAgent } from "../src/extensions/subagent/index.ts";
import { runTurn } from "../src/extensions/subagent/runner.ts";

const fixtures = vi.hoisted(() => ({ agentDir: "", transcripts: vi.fn() }));
vi.mock("../src/config.ts", async (original) => ({
	...(await original<object>()),
	getAgentDir: () => fixtures.agentDir,
}));
vi.mock("../src/extensions/subagent/transcript.ts", () => ({
	appendTranscript: fixtures.transcripts,
	renderTranscript: () => "transcript",
}));
// Keep all execution local. No loader or provider setup is needed for resident sessions.
vi.mock("../src/core/sdk.ts", () => ({ createAgentSession: vi.fn() }));
vi.mock("../src/core/model-runtime.ts", () => ({ ModelRuntime: { create: vi.fn(async () => ({})) } }));
vi.mock("../src/core/resource-loader.ts", () => ({
	DefaultResourceLoader: class {
		async reload() {}
	},
}));
vi.mock("../src/core/settings-manager.ts", () => ({ SettingsManager: { create: () => ({}) } }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function assistant(stopReason: "stop" | "error", text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		errorMessage: stopReason === "error" ? text : undefined,
		usage: { input: 1, output: 1 },
		timestamp: 0,
	} as AssistantMessage;
}
function setup() {
	fixtures.agentDir = mkdtempSync(join(tmpdir(), "subagent-wiring-"));
	const cwd = fixtures.agentDir;
	const settled = deferred();
	const started = deferred();
	const messages: AgentMessage[] = [];
	let idle = true;
	const session = {
		agent: { state: { messages } },
		get isIdle() {
			return idle;
		},
		get isStreaming() {
			return !idle;
		},
		subscribe: vi.fn(() => vi.fn()),
		prompt: vi.fn(async () => {
			idle = false;
			started.resolve();
			await settled.promise;
			idle = true;
		}),
		followUp: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {
			if (!idle) await settled.promise;
		}),
		abort: vi.fn(async () => {
			idle = true;
			settled.resolve();
		}),
	} as unknown as AgentSession;
	const handle: ChildHandle = {
		id: "subagent-1",
		ownerSession: "parent",
		cwd,
		session,
		status: "idle",
		tools: ["read"],
		turns: 0,
		createdAt: 0,
		lastActiveAt: 0,
	};
	register(handle);
	const ctx = { cwd, sessionManager: { getSessionId: () => "parent" } } as ExtensionContext;
	return {
		handle,
		ctx,
		session,
		messages,
		started,
		settled,
		directory: childSessionDir(cwd, "parent", fixtures.agentDir),
	};
}
function terminal(directory: string, runId: string): Promise<BackgroundTaskRecord> {
	return new Promise((resolve) => {
		const done = (record: BackgroundTaskRecord | undefined) => {
			if (record && !["running", "queued"].includes(record.status)) {
				unsubscribe();
				resolve(record);
			}
		};
		const unsubscribe = backgroundTasks.subscribe((event) => {
			if (event.type === "change" && event.record.runId === runId) done(event.record);
		});
		done(backgroundTasks.get(directory, "parent", runId));
	});
}
afterEach(() => {
	resetRegistry();
	fixtures.transcripts.mockClear();
	vi.mocked(createAgentSession).mockReset();
	if (fixtures.agentDir) rmSync(fixtures.agentDir, { recursive: true, force: true });
});

describe("agent background wiring", () => {
	it("registers a new background child before creation and normalizes its tools", async () => {
		const f = setup();
		const releases = await Promise.all(Array.from({ length: 6 }, () => childSlots.acquire()));
		vi.mocked(createAgentSession).mockImplementation(
			async (options) =>
				({
					session: Object.assign(f.session, {
						sessionManager: options!.sessionManager!,
						getActiveToolNames: () => options!.tools!,
					}),
				}) as Awaited<ReturnType<typeof createAgentSession>>,
		);
		let result: Awaited<ReturnType<typeof executeAgent>>;
		try {
			result = await executeAgent(
				"new",
				{ prompt: "new work", tools: "read, grep", run_in_background: true },
				undefined,
				undefined,
				f.ctx,
			);
			expect(result.details).toMatchObject({ tools: ["read", "grep"], background: true });
			expect(result.details!.childId).toMatch(/^subagent-[0-9a-f-]{36}$/);
			expect(createAgentSession).not.toHaveBeenCalled();
			for (const prompt of ["extra one", "extra two"]) {
				const follow = await executeAgent(
					"follow",
					{
						prompt,
						resume: result.details!.childId,
						tools: "bash",
						run_in_background: true,
					},
					undefined,
					undefined,
					f.ctx,
				);
				expect(follow.details).toMatchObject({
					runId: result.details!.runId,
					tools: ["read", "grep"],
					queued: true,
				});
			}
			expect(backgroundTasks.list(f.directory, "parent")).toHaveLength(1);
		} finally {
			for (const release of releases) release();
		}
		await f.started.promise;
		const done = terminal(f.directory, result.details!.runId!);
		f.messages.push(assistant("stop", "created"));
		f.settled.resolve();
		expect((await done).result?.text).toContain("实际工具：read, grep");
		expect(f.session.prompt).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.session.prompt).mock.calls[0][0]).toBe(
			"new work\n\n--- 追加指令（按接收顺序）---\n\nextra one\n\n--- 追加指令（按接收顺序）---\n\nextra two",
		);
		expect(fixtures.transcripts).toHaveBeenCalledTimes(1);
	});
	it("merges resume while createAgentSession is pending without changing permissions", async () => {
		const f = setup();
		const creating = deferred();
		const ready = deferred();
		vi.mocked(createAgentSession).mockImplementation(async (options) => {
			creating.resolve();
			await ready.promise;
			return {
				session: Object.assign(f.session, {
					sessionManager: options!.sessionManager!,
					getActiveToolNames: () => options!.tools!,
				}),
			} as Awaited<ReturnType<typeof createAgentSession>>;
		});
		const result = await executeAgent(
			"start",
			{ prompt: "original", tools: [], run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		await creating.promise;
		const follow = await executeAgent(
			"follow",
			{ prompt: "addition", resume: result.details!.childId, tools: "bash", run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		expect(follow.details).toMatchObject({ runId: result.details!.runId, tools: [], queued: true });
		expect(createAgentSession).toHaveBeenCalledTimes(1);
		expect(f.session.prompt).not.toHaveBeenCalled();
		ready.resolve();
		await f.started.promise;
		const done = terminal(f.directory, result.details!.runId!);
		f.settled.resolve();
		expect((await done).status).toBe("completed");
		expect(vi.mocked(f.session.prompt).mock.calls[0][0]).toBe(
			"original\n\n--- 追加指令（按接收顺序）---\n\naddition",
		);
		expect(f.session.prompt).toHaveBeenCalledTimes(1);
		expect(fixtures.transcripts).toHaveBeenCalledTimes(1);
		expect(backgroundTasks.list(f.directory, "parent")).toHaveLength(1);
	});
	it("cleans up a cancelled new child waiting for a slot and refuses history-free resume", async () => {
		const f = setup();
		const releases = await Promise.all(Array.from({ length: 6 }, () => childSlots.acquire()));
		try {
			const result = await executeAgent(
				"start",
				{ prompt: "original", tools: [], run_in_background: true },
				undefined,
				undefined,
				f.ctx,
			);
			const done = terminal(f.directory, result.details!.runId!);
			backgroundTasks.cancel(f.directory, "parent", result.details!.runId!);
			await expect(
				executeAgent(
					"follow",
					{ prompt: "addition", resume: result.details!.childId, tools: "bash" },
					undefined,
					undefined,
					f.ctx,
				),
			).rejects.toThrow("正在取消");
			expect((await done).status).toBe("cancelled");
			await expect(
				executeAgent(
					"follow",
					{ prompt: "addition", resume: result.details!.childId, tools: "bash" },
					undefined,
					undefined,
					f.ctx,
				),
			).rejects.toThrow("无可恢复的会话历史");
			expect(backgroundTasks.list(f.directory, "parent")).toHaveLength(1);
			expect(createAgentSession).not.toHaveBeenCalled();
		} finally {
			for (const release of releases) release();
		}
	});
	it("cleans up when cancelled synchronously before the background executor starts", async () => {
		const f = setup();
		const unsubscribe = backgroundTasks.subscribe((event) => {
			if (event.type === "change" && event.record.status === "queued" && event.record.owner === "parent") {
				backgroundTasks.cancel(f.directory, "parent", event.record.runId);
			}
		});
		try {
			const result = await executeAgent(
				"start",
				{ prompt: "original", tools: [], run_in_background: true },
				undefined,
				undefined,
				f.ctx,
			);
			expect((await terminal(f.directory, result.details!.runId!)).status).toBe("cancelled");
			await expect(
				executeAgent(
					"follow",
					{ prompt: "addition", resume: result.details!.childId },
					undefined,
					undefined,
					f.ctx,
				),
			).rejects.toThrow("无可恢复的会话历史");
			expect(createAgentSession).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});
	it("cancels during initialization without prompting and allows a later explicit resume", async () => {
		const f = setup();
		const creating = deferred();
		const ready = deferred();
		vi.mocked(createAgentSession).mockImplementation(async (options) => {
			creating.resolve();
			await ready.promise;
			return {
				session: Object.assign(f.session, {
					sessionManager: options!.sessionManager!,
					getActiveToolNames: () => options!.tools!,
				}),
			} as Awaited<ReturnType<typeof createAgentSession>>;
		});
		const result = await executeAgent(
			"start",
			{ prompt: "original", tools: [], run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		await creating.promise;
		const done = terminal(f.directory, result.details!.runId!);
		backgroundTasks.cancel(f.directory, "parent", result.details!.runId!);
		await expect(
			executeAgent("follow", { prompt: "discarded", resume: result.details!.childId }, undefined, undefined, f.ctx),
		).rejects.toThrow("正在取消");
		ready.resolve();
		expect((await done).status).toBe("cancelled");
		expect(f.session.prompt).not.toHaveBeenCalled();
		const resumed = await executeAgent(
			"resume",
			{ prompt: "explicit retry", resume: result.details!.childId, tools: "bash", run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		expect(resumed.details).toMatchObject({ tools: [] });
		expect(resumed.details!.runId).not.toBe(result.details!.runId);
		expect((await terminal(f.directory, resumed.details!.runId!)).status).toBe("completed");
		expect(vi.mocked(f.session.prompt).mock.calls.map(([prompt]) => prompt)).toEqual(["explicit retry"]);
		expect(createAgentSession).toHaveBeenCalledTimes(1);
	});
	it("keeps initialization failures observable and removes their pending entry", async () => {
		const f = setup();
		const creating = deferred();
		const ready = deferred();
		vi.mocked(createAgentSession).mockImplementation(async () => {
			creating.resolve();
			await ready.promise;
			throw new Error("initialization failed");
		});
		const result = await executeAgent(
			"start",
			{ prompt: "original", tools: [], run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		await creating.promise;
		await executeAgent(
			"follow",
			{ prompt: "addition", resume: result.details!.childId },
			undefined,
			undefined,
			f.ctx,
		);
		const done = terminal(f.directory, result.details!.runId!);
		ready.resolve();
		expect(await done).toMatchObject({ status: "failed", result: { failed: "initialization failed" } });
		await expect(
			executeAgent(
				"follow",
				{ prompt: "addition", resume: result.details!.childId, tools: "bash" },
				undefined,
				undefined,
				f.ctx,
			),
		).rejects.toThrow("无可恢复的会话历史");
		expect(createAgentSession).toHaveBeenCalledTimes(1);
	});
	it("retains additions during idle prompt preprocessing in the same run", async () => {
		const f = setup();
		const preprocessing = deferred();
		const ready = deferred();
		vi.mocked(f.session.prompt).mockImplementationOnce(async () => {
			preprocessing.resolve();
			await ready.promise;
		});
		const result = await executeAgent(
			"start",
			{ prompt: "original", resume: f.handle.id, run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		await preprocessing.promise;
		const follow = await executeAgent(
			"follow",
			{ prompt: "addition", resume: f.handle.id },
			undefined,
			undefined,
			f.ctx,
		);
		expect(follow.details!.runId).toBe(result.details!.runId);
		expect(f.session.followUp).not.toHaveBeenCalled();
		ready.resolve();
		await f.started.promise;
		const done = terminal(f.directory, result.details!.runId!);
		f.settled.resolve();
		expect((await done).status).toBe("completed");
		expect(vi.mocked(f.session.prompt).mock.calls.map(([prompt]) => prompt)).toEqual(["original", "addition"]);
		expect(backgroundTasks.list(f.directory, "parent")).toHaveLength(1);
	});
	it("returns a durable id while slots are full; parent abort cannot cancel it; queued task can cancel", async () => {
		const f = setup();
		const releases = await Promise.all(Array.from({ length: 6 }, () => childSlots.acquire()));
		try {
			const parent = new AbortController();
			const update = vi.fn();
			const result = await executeAgent(
				"tool",
				{ prompt: "work", resume: f.handle.id, run_in_background: true },
				parent.signal,
				update,
				f.ctx,
			);
			const runId = result.details!.runId!;
			expect(backgroundTasks.get(f.directory, "parent", runId)).toBeDefined();
			expect(f.session.prompt).not.toHaveBeenCalled();
			const follow = await executeAgent(
				"follow",
				{ prompt: "extra", resume: f.handle.id, tools: "bash", run_in_background: true },
				undefined,
				undefined,
				f.ctx,
			);
			expect(follow.details).toMatchObject({ runId, tools: ["read"], queued: true });
			expect(backgroundTasks.list(f.directory, "parent")).toHaveLength(1);
			parent.abort();
			expect(backgroundTasks.get(f.directory, "parent", runId)?.cancelRequestedAt).toBeUndefined();
			const done = terminal(f.directory, runId);
			backgroundTasks.cancel(f.directory, "parent", runId);
			expect((await done).status).toBe("cancelled");
			expect(f.session.prompt).not.toHaveBeenCalled();
			expect(update).not.toHaveBeenCalled();
		} finally {
			for (const release of releases) release();
		}
	});
	it("continues after return, queues running follow-up without a second monitor, and writes once", async () => {
		const f = setup();
		const result = await executeAgent(
			"tool",
			{ prompt: "work", resume: f.handle.id, run_in_background: true },
			undefined,
			vi.fn(),
			f.ctx,
		);
		await f.started.promise;
		const follow = await executeAgent(
			"follow",
			{ prompt: "more", resume: f.handle.id, tools: "bash" },
			undefined,
			undefined,
			f.ctx,
		);
		expect(follow.details).toMatchObject({ queued: true, runId: result.details!.runId, tools: ["read"] });
		expect(f.session.followUp).toHaveBeenCalledWith("more");
		expect(f.session.subscribe).toHaveBeenCalledTimes(1);
		const done = terminal(f.directory, result.details!.runId!);
		f.messages.push(assistant("stop", "done"));
		f.settled.resolve();
		expect((await done).status).toBe("completed");
		expect(fixtures.transcripts).toHaveBeenCalledTimes(1);
	});
	it("merges idle resumes while waiting for the global slot limit", async () => {
		const f = setup();
		const releases = await Promise.all(Array.from({ length: 6 }, () => childSlots.acquire()));
		const first = executeAgent("a", { prompt: "one", resume: f.handle.id }, undefined, undefined, f.ctx);
		const second = await executeAgent(
			"b",
			{ prompt: "two", resume: f.handle.id, tools: "bash" },
			undefined,
			undefined,
			f.ctx,
		);
		expect(second.details).toMatchObject({ queued: true, tools: ["read"] });
		await Promise.resolve();
		await Promise.resolve();
		expect(f.session.prompt).not.toHaveBeenCalled();
		for (const release of releases) release();
		await f.started.promise;
		expect(f.session.subscribe).toHaveBeenCalledTimes(1);
		f.settled.resolve();
		await first;
		expect(f.session.prompt).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.session.prompt).mock.calls[0][0]).toBe("one\n\n--- 追加指令（按接收顺序）---\n\ntwo");
		expect(fixtures.transcripts).toHaveBeenCalledTimes(1);
	});
	it("does not report registration success or execute when durable storage fails", async () => {
		const f = setup();
		rmSync(fixtures.agentDir, { recursive: true, force: true });
		writeFileSync(fixtures.agentDir, "blocks child directory");
		await expect(
			executeAgent(
				"tool",
				{ prompt: "work", resume: f.handle.id, run_in_background: true },
				undefined,
				undefined,
				f.ctx,
			),
		).rejects.toThrow();
		expect(f.session.prompt).not.toHaveBeenCalled();
	});
	it("rejects foreign children and pre-aborted calls before registering a task", async () => {
		const f = setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			executeAgent("tool", { prompt: "work", run_in_background: true }, controller.signal, undefined, f.ctx),
		).rejects.toThrow();
		const foreign = { ...f.ctx, sessionManager: { getSessionId: () => "other" } } as ExtensionContext;
		await expect(
			executeAgent(
				"tool",
				{ prompt: "work", resume: f.handle.id, run_in_background: true },
				undefined,
				undefined,
				foreign,
			),
		).rejects.toThrow("未知子 agent");
		expect(backgroundTasks.list(f.directory, "parent")).toEqual([]);
	});
	it("cancels a running background task with its own signal", async () => {
		const f = setup();
		const result = await executeAgent(
			"tool",
			{ prompt: "work", resume: f.handle.id, run_in_background: true },
			undefined,
			undefined,
			f.ctx,
		);
		await f.started.promise;
		const done = terminal(f.directory, result.details!.runId!);
		backgroundTasks.cancel(f.directory, "parent", result.details!.runId!);
		expect((await done).status).toBe("cancelled");
		expect(f.session.abort).toHaveBeenCalledOnce();
	});
});

describe("runTurn completion", () => {
	it("waits for session idle after prompt resolves and uses only the final assistant error", async () => {
		const f = setup();
		const idle = deferred();
		vi.mocked(f.session.prompt).mockImplementation(async () => {
			f.messages.push(assistant("error", "retryable"));
		});
		vi.mocked(f.session.waitForIdle).mockImplementation(async () => {
			await idle.promise;
			f.messages.push(assistant("stop", "recovered"));
		});
		let finished = false;
		const run = runTurn({
			handle: f.handle,
			parentSessionId: "parent",
			prompt: "work",
			resumed: true,
			signal: undefined,
		}).then((outcome) => {
			finished = true;
			return outcome;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(finished).toBe(false);
		idle.resolve();
		expect(await run).toMatchObject({ text: "recovered", failed: undefined, tools: ["read"] });
	});
	it("reports only terminal provider errors and classifies watchdog abort as stalled", async () => {
		const f = setup();
		vi.mocked(f.session.prompt).mockImplementationOnce(async () => {
			f.messages.push(assistant("error", "terminal"));
		});
		expect(
			await runTurn({
				handle: f.handle,
				parentSessionId: "parent",
				prompt: "work",
				resumed: true,
				signal: undefined,
			}),
		).toMatchObject({ failed: "terminal" });
		vi.useFakeTimers();
		try {
			const run = runTurn({
				handle: f.handle,
				parentSessionId: "parent",
				prompt: "again",
				resumed: true,
				signal: undefined,
			});
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(await run).toMatchObject({ stalled: true, aborted: false });
		} finally {
			vi.useRealTimers();
		}
	});
	it("never prompts for a pre-aborted signal", async () => {
		const f = setup();
		const controller = new AbortController();
		controller.abort();
		const result = await runTurn({
			handle: f.handle,
			parentSessionId: "parent",
			prompt: "work",
			resumed: true,
			signal: controller.signal,
		});
		expect(f.session.prompt).not.toHaveBeenCalled();
		expect(result.aborted).toBe(true);
	});
});
