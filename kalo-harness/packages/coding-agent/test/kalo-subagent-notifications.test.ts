import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const fixtures = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("../src/config.ts", async (original) => ({
	...(await original<object>()),
	getAgentDir: () => fixtures.agentDir,
}));

import {
	type BackgroundTaskRecord,
	type BackgroundTaskResult,
	backgroundTasks,
} from "../src/extensions/subagent/background.ts";
import { childSessionDir } from "../src/extensions/subagent/children.ts";
import { registerBackgroundNotifications } from "../src/extensions/subagent/notifications.ts";

const agentDirs: string[] = [];
const harnesses: Harness[] = [];

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeContext(_agentDir: string, owner: string, cwd: string, idle = true): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => owner },
		ui: { setStatus: vi.fn() },
		isIdle: () => idle,
	} as unknown as ExtensionContext;
}

function freshContext(ctx: ExtensionContext): ExtensionContext {
	return {
		cwd: ctx.cwd,
		sessionManager: ctx.sessionManager,
		ui: ctx.ui,
		isIdle: ctx.isIdle,
	} as unknown as ExtensionContext;
}

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
	const state = { throwOnSend: false };
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			if (state.throwOnSend) throw new Error("runtime replaced");
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools, sent, state };
}

function startTask(directory: string, owner: string, result: BackgroundTaskResult, childId = "child-1") {
	return backgroundTasks.start({ directory, owner, childId, run: async () => result });
}

async function settleLastDelivery(
	fake: ReturnType<typeof fakePi>,
	ctx: ExtensionContext,
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
): Promise<void> {
	const sent = fake.sent.at(-1);
	if (!sent) throw new Error("notification was not sent");
	const details = sent.message.details as { runIds: string[] };
	fake.handlers.get("message_end")?.(
		{
			message: {
				role: "custom",
				customType: "kalo-subagent-done",
				content: [{ type: "text", text: "accepted" }],
				display: true,
				details,
			},
		},
		freshContext(ctx),
	);
	fake.handlers.get("message_end")?.(
		{
			message: {
				role: "assistant",
				content: [],
				stopReason,
				timestamp: Date.now(),
			},
		},
		freshContext(ctx),
	);
	fake.handlers.get("agent_settled")?.({}, freshContext(ctx));
	await setImmediate();
}

function sessionSetup(owner = "parent-a", idle = true) {
	const cwd = mkdtempSync(join(tmpdir(), "kalo-notifications-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "kalo-notifications-agent-"));
	fixtures.agentDir = agentDir;
	agentDirs.push(cwd, agentDir);
	const ctx = fakeContext(agentDir, owner, cwd, idle);
	const fake = fakePi();
	registerBackgroundNotifications(fake.pi);
	fake.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	return { cwd, agentDir, ctx, fake, directory: childSessionDir(cwd, owner, agentDir) };
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	fixtures.agentDir = "";
	for (const directory of agentDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background notification state machine", () => {
	it("routes by cwd and owner, and query does not acknowledge a result", async () => {
		const session = sessionSetup();
		const foreignDir = mkdtempSync(join(tmpdir(), "kalo-notifications-foreign-"));
		agentDirs.push(foreignDir);
		const foreign = startTask(foreignDir, "parent-b", { text: "private" }, "foreign-child");
		const sameDirectoryForeign = startTask(
			session.directory,
			"parent-b",
			{ text: "same directory private" },
			"same-directory",
		);
		const own = startTask(session.directory, "parent-a", {
			text: "visible",
			failed: "warning",
			transcriptPath: "child.md",
		});
		await setImmediate();
		await setImmediate();
		const tool = session.fake.tools.get("agent_tasks");
		if (!tool) throw new Error("agent_tasks not registered");
		const listed = (await tool.execute("list", { action: "list" }, undefined, undefined, session.ctx)) as {
			content: Array<{ text: string }>;
			details: { tasks: BackgroundTaskRecord[] };
		};
		expect(listed.details.tasks.map((task) => task.runId)).toEqual([own.runId]);
		expect(listed.content[0].text).toContain("visible");
		expect(listed.content[0].text).toContain("warning");
		expect(backgroundTasks.get(foreignDir, "parent-a", foreign.runId)).toBeUndefined();
		expect(backgroundTasks.get(session.directory, "parent-a", sameDirectoryForeign.runId)).toBeUndefined();
		expect(backgroundTasks.get(session.directory, "parent-a", own.runId)?.acknowledged).toBe(false);
	});

	it("accepts fresh per-event contexts when session identity is stable", async () => {
		const session = sessionSetup();
		const task = startTask(session.directory, "parent-a", { text: "fresh context" });
		await setImmediate();
		await setImmediate();
		const sent = session.fake.sent.at(-1);
		if (!sent) throw new Error("notification was not sent");
		const details = sent.message.details as { runIds: string[] };
		session.fake.handlers.get("message_end")?.(
			{ message: { role: "custom", customType: "kalo-subagent-done", details } },
			freshContext(session.ctx),
		);
		session.fake.handlers.get("message_end")?.(
			{ message: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } },
			freshContext(session.ctx),
		);
		session.fake.handlers.get("agent_settled")?.({}, freshContext(session.ctx));
		await setImmediate();
		expect(backgroundTasks.get(session.directory, "parent-a", task.runId)?.acknowledged).toBe(true);
	});

	it("does not let a shutdown-era drain mutate the next session status", async () => {
		const session = sessionSetup();
		const oldSetStatus = vi.mocked(session.ctx.ui.setStatus);
		startTask(session.directory, "parent-a", { text: "old session" });
		oldSetStatus.mockClear();
		const nextContext = fakeContext(session.agentDir, "parent-a", session.cwd);
		session.fake.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, nextContext);
		await setImmediate();
		expect(oldSetStatus).not.toHaveBeenCalledWith("kalo-subagent-background", expect.stringContaining("个结果"));
	});

	it("persists before delivery, keeps the status alive, and acknowledges only after accepted message and settled success", async () => {
		const session = sessionSetup();
		const task = startTask(session.directory, "parent-a", { text: "durable result" });
		await setImmediate();
		await setImmediate();
		expect(session.fake.sent).toHaveLength(1);
		expect(session.fake.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(session.ctx.ui.setStatus).toHaveBeenCalledWith(
			"kalo-subagent-background",
			expect.stringContaining("1 个结果"),
		);
		expect(backgroundTasks.get(session.directory, "parent-a", task.runId)?.acknowledged).toBe(false);
		const sentCount = session.fake.sent.length;
		// A query and a custom message that merely resembles the notification do not ack it.
		const tool = session.fake.tools.get("agent_tasks");
		await tool?.execute("output", { action: "output", run_id: task.runId }, undefined, undefined, session.ctx);
		session.fake.handlers.get("message_end")?.(
			{ message: { role: "custom", customType: "other", details: { runIds: [task.runId] } } },
			session.ctx,
		);
		expect(session.fake.sent).toHaveLength(sentCount);
		expect(backgroundTasks.get(session.directory, "parent-a", task.runId)?.acknowledged).toBe(false);
		await settleLastDelivery(session.fake, session.ctx);
		expect(backgroundTasks.get(session.directory, "parent-a", task.runId)?.acknowledged).toBe(true);
		expect(session.ctx.ui.setStatus).toHaveBeenLastCalledWith("kalo-subagent-background", undefined);
	});

	it("does not ack when settled has no successful assistant message", async () => {
		const session = sessionSetup();
		const task = startTask(session.directory, "parent-a", { text: "must remain pending" });
		await setImmediate();
		await setImmediate();
		const sent = session.fake.sent.at(-1);
		if (!sent) throw new Error("notification was not sent");
		const details = sent.message.details as { runIds: string[] };
		session.fake.handlers.get("message_end")?.(
			{ message: { role: "custom", customType: "kalo-subagent-done", details } },
			freshContext(session.ctx),
		);
		session.fake.handlers.get("agent_settled")?.({}, freshContext(session.ctx));
		await setImmediate();
		expect(backgroundTasks.get(session.directory, "parent-a", task.runId)?.acknowledged).toBe(false);
	});

	it("counts busy follow-ups against the same three-wake budget", async () => {
		const session = sessionSetup("parent-busy", false);
		for (let index = 0; index < 3; index += 1) {
			startTask(session.directory, "parent-busy", { text: `busy-${index}` }, `busy-${index}`);
			await setImmediate();
			await setImmediate();
			await settleLastDelivery(session.fake, session.ctx);
		}
		startTask(session.directory, "parent-busy", { text: "busy-over-budget" }, "busy-over-budget");
		await setImmediate();
		await setImmediate();
		expect(session.fake.sent).toHaveLength(3);
	});

	it("blocks automatic change retries after synchronous send failure until user input", async () => {
		const session = sessionSetup();
		session.fake.state.throwOnSend = true;
		startTask(session.directory, "parent-a", { text: "not accepted" });
		await setImmediate();
		await setImmediate();
		expect(session.fake.sent).toHaveLength(0);
		session.fake.state.throwOnSend = false;
		startTask(session.directory, "parent-a", { text: "also pending" }, "second");
		await setImmediate();
		expect(session.fake.sent).toHaveLength(0);
		session.fake.handlers.get("input")?.({ source: "interactive", text: "retry" }, freshContext(session.ctx));
		await setImmediate();
		expect(session.fake.sent).toHaveLength(1);
	});

	it("keeps the last snapshot and status alive when storage reads fail", async () => {
		const session = sessionSetup();
		const retainedRunId = randomUUID();
		mkdirSync(session.directory, { recursive: true });
		writeFileSync(
			join(session.directory, `background-${retainedRunId}.json`),
			JSON.stringify({
				version: 1,
				runId: retainedRunId,
				owner: "parent-a",
				childId: "retained",
				status: "completed",
				createdAt: 10,
				updatedAt: 20,
				finishedAt: 20,
				acknowledged: true,
				result: { text: "retained" },
			}),
		);
		session.fake.handlers.get("input")?.({ source: "rpc" }, freshContext(session.ctx));
		await setImmediate();
		await setImmediate();
		const listSpy = vi.spyOn(backgroundTasks, "list").mockImplementation(() => {
			throw new Error("disk unavailable");
		});
		startTask(session.directory, "parent-a", { text: "must stay pending" });
		await setImmediate();
		await setImmediate();
		expect(session.fake.sent).toHaveLength(0);
		expect(session.ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"kalo-subagent-background",
			expect.stringContaining("存储错误"),
		);
		listSpy.mockRestore();
		session.fake.handlers.get("input")?.({ source: "rpc" }, freshContext(session.ctx));
		await setImmediate();
		expect(session.fake.sent).toHaveLength(1);
	});

	it.each(["length", "toolUse", "error", "aborted"] as const)(
		"does not ack an accepted notification when the final assistant stopReason is %s",
		async (stopReason) => {
			const session = sessionSetup(`parent-${stopReason}`);
			const task = startTask(session.directory, `parent-${stopReason}`, { text: "retry me" });
			await setImmediate();
			await setImmediate();
			const before = session.fake.sent.length;
			await settleLastDelivery(session.fake, session.ctx, stopReason);
			expect(backgroundTasks.get(session.directory, `parent-${stopReason}`, task.runId)?.acknowledged).toBe(false);
			expect(session.fake.sent).toHaveLength(before);
			expect(session.ctx.ui.setStatus).toHaveBeenLastCalledWith(
				"kalo-subagent-background",
				expect.stringContaining("1 个结果待处理"),
			);
			session.fake.handlers.get("input")?.({ source: "interactive", text: "continue" }, session.ctx);
			await setImmediate();
			expect(session.fake.sent).toHaveLength(before + 1);
			await settleLastDelivery(session.fake, session.ctx, "stop");
			expect(backgroundTasks.get(session.directory, `parent-${stopReason}`, task.runId)?.acknowledged).toBe(true);
			session.fake.handlers.get("session_shutdown")?.({}, session.ctx);
		},
	);

	it("limits notification batches to twenty tasks and keeps the body bounded", async () => {
		const session = sessionSetup();
		for (let index = 0; index < 25; index += 1) {
			startTask(session.directory, "parent-a", { text: `result-${index}` }, `child-${index}`);
		}
		await setImmediate();
		await setImmediate();
		const sent = session.fake.sent.at(-1);
		if (!sent) throw new Error("notification was not sent");
		expect((sent.message.details as { runIds: string[] }).runIds.length).toBeLessThanOrEqual(20);
		expect(String(sent.message.content).length).toBeLessThanOrEqual(12_000);
	});

	it("limits agent_tasks list results to fifty summaries", async () => {
		const session = sessionSetup();
		for (let index = 0; index < 55; index += 1) {
			startTask(session.directory, "parent-a", { text: `list-${index}` }, `list-child-${index}`);
		}
		await setImmediate();
		await setImmediate();
		const tool = session.fake.tools.get("agent_tasks");
		if (!tool) throw new Error("agent_tasks not registered");
		const listed = (await tool.execute(
			"list",
			{ action: "list" },
			undefined,
			undefined,
			freshContext(session.ctx),
		)) as {
			details: { count: number; shown: number; truncated: boolean; tasks: unknown[] };
		};
		expect(listed.details.count).toBe(55);
		expect(listed.details.shown).toBeLessThanOrEqual(50);
		expect(listed.details.tasks).toHaveLength(listed.details.shown);
		expect(listed.details.truncated).toBe(true);
	});

	it("limits automatic wakes to three batches and resets the budget only for real user input", async () => {
		const session = sessionSetup();
		for (let index = 0; index < 3; index += 1) {
			startTask(session.directory, "parent-a", { text: `batch-${index}` }, `child-${index}`);
			await setImmediate();
			await setImmediate();
			await settleLastDelivery(session.fake, session.ctx);
		}
		const fourth = startTask(session.directory, "parent-a", { text: "batch-4" }, "child-4");
		await setImmediate();
		await setImmediate();
		expect(session.fake.sent).toHaveLength(3);
		session.fake.handlers.get("input")?.({ source: "extension", text: "not a user" }, session.ctx);
		await setImmediate();
		expect(session.fake.sent).toHaveLength(3);
		session.fake.handlers.get("input")?.({ source: "rpc", text: "real user" }, session.ctx);
		await setImmediate();
		expect(session.fake.sent).toHaveLength(4);
		expect((session.fake.sent.at(-1)?.message.details as { runIds: string[] }).runIds).toContain(fourth.runId);
	});

	it.each(["idle", "busy"] as const)(
		"delivers async results through real AgentSession while %s and acknowledges only after settled",
		async (mode) => {
			const agentDir = mkdtempSync(join(tmpdir(), "kalo-notifications-agent-"));
			fixtures.agentDir = agentDir;
			agentDirs.push(agentDir);
			const contexts: ExtensionContext[] = [];
			const extensionEvents: string[] = [];
			const ackAtMessageEnd: boolean[] = [];
			let task: BackgroundTaskRecord | undefined;
			let directory = "";
			let owner = "";
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						registerBackgroundNotifications(pi);
						pi.on("session_start", (_event, ctx) => {
							contexts.push(ctx);
						});
						pi.on("message_end", (event, ctx) => {
							contexts.push(ctx);
							if (event.message.role === "custom" && event.message.customType === "kalo-subagent-done") {
								extensionEvents.push("custom");
								expect(event.message.details).toEqual({ runIds: [task?.runId] });
							} else if (event.message.role === "assistant") {
								extensionEvents.push("assistant");
							}
							if (task) {
								ackAtMessageEnd.push(backgroundTasks.get(directory, owner, task.runId)?.acknowledged === true);
							}
						});
						pi.on("agent_settled", (_event, ctx) => {
							contexts.push(ctx);
							extensionEvents.push("settled");
						});
					},
				],
			});
			harnesses.push(harness);
			const mainStarted = deferred<void>();
			const mainRelease = deferred<void>();
			const childRelease = deferred<BackgroundTaskResult>();
			const notificationSettled = deferred<void>();
			harness.setResponses([
				async () => {
					mainStarted.resolve();
					await mainRelease.promise;
					return fauxAssistantMessage("main turn complete");
				},
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("async child result");
					return fauxAssistantMessage("parent accepted");
				},
			]);
			await harness.session.bindExtensions({});
			owner = harness.sessionManager.getSessionId();
			directory = childSessionDir(harness.tempDir, owner, agentDir);
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled" && extensionEvents.includes("custom")) {
					notificationSettled.resolve();
				}
			});
			const mainPrompt = harness.session.prompt("start the main turn");
			try {
				await mainStarted.promise;
				task = backgroundTasks.start({ directory, owner, childId: "async-child", run: () => childRelease.promise });
				await setImmediate();
				if (mode === "idle") {
					mainRelease.resolve();
					await mainPrompt;
					expect(extensionEvents).toEqual(["assistant", "settled"]);
					expect(harness.session.isStreaming).toBe(false);
				}
				expect(backgroundTasks.get(directory, owner, task.runId)?.status).toBe("running");
				childRelease.resolve({ text: "async child result" });
				if (mode === "busy") {
					await setImmediate();
					expect(harness.session.isStreaming).toBe(true);
					expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
					expect(backgroundTasks.get(directory, owner, task.runId)?.acknowledged).toBe(false);
					mainRelease.resolve();
				}
				await mainPrompt;
				await notificationSettled.promise;
				expect(extensionEvents).toEqual(
					mode === "idle"
						? ["assistant", "settled", "custom", "assistant", "settled"]
						: ["assistant", "custom", "assistant", "settled"],
				);
				expect(ackAtMessageEnd.length).toBeGreaterThanOrEqual(3);
				expect(ackAtMessageEnd.every((acknowledged) => !acknowledged)).toBe(true);
				expect(backgroundTasks.get(directory, owner, task.runId)?.acknowledged).toBe(true);
				expect(harness.faux.state.callCount).toBe(2);
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(new Set(contexts).size).toBe(contexts.length);
				expect(contexts.every((ctx) => ctx.sessionManager === harness.sessionManager)).toBe(true);
			} finally {
				mainRelease.resolve();
				childRelease.resolve({ text: "cleanup" });
				unsubscribe();
				await harness.session.abort();
				await mainPrompt;
			}
		},
	);

	it("replays durable terminal results after a new session binds, without a timer loop", async () => {
		const session = sessionSetup("parent-recovery");
		const directory = session.directory;
		mkdirSync(directory, { recursive: true });
		const runId = randomUUID();
		const record: BackgroundTaskRecord = {
			version: 1,
			runId,
			owner: "parent-recovery",
			childId: "old-child",
			status: "running",
			createdAt: 10,
			updatedAt: 20,
			startedAt: 20,
			finishedAt: undefined,
			acknowledged: false,
		};
		writeFileSync(join(directory, `background-${runId}.json`), JSON.stringify(record));
		// A fresh binding sees the previous-process running record, marks it interrupted,
		// and sends exactly one replayable notification.
		session.fake.handlers.get("session_shutdown")?.({}, session.ctx);
		session.fake.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, session.ctx);
		await setImmediate();
		await setImmediate();
		expect(session.fake.sent).toHaveLength(1);
		expect((session.fake.sent[0].message.details as { runIds: string[] }).runIds).toEqual([runId]);
		expect(backgroundTasks.get(directory, "parent-recovery", runId)?.status).toBe("interrupted");
	});
});
