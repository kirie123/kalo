import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { RunCancellation } from "../src/core/run-cancellation.ts";
import { backgroundTasks } from "../src/extensions/subagent/background.ts";
import { childSessionDir } from "../src/extensions/subagent/children.ts";
import { registerBackgroundNotifications } from "../src/extensions/subagent/notifications.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session resume and cancellation", () => {
	it("opens historical pending results without a model call, then handles them with explicit input", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "kalo-resume-stop-"));
		directories.push(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const harness = await createHarness({ extensionFactories: [registerBackgroundNotifications] });
		harnesses.push(harness);
		const owner = harness.sessionManager.getSessionId();
		const directory = childSessionDir(harness.tempDir, owner, agentDir);
		const task = backgroundTasks.start({
			directory,
			owner,
			childId: "old-child",
			run: async () => ({ text: "old result" }),
		});
		await setImmediate();
		await harness.session.bindExtensions({});
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		await setImmediate();
		await setImmediate();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages).toHaveLength(0);
		expect(backgroundTasks.get(directory, owner, task.runId)?.acknowledged).toBe(false);
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("old result");
				expect(JSON.stringify(context.messages)).toContain("explicit new input");
				return fauxAssistantMessage("handled");
			},
		]);
		await harness.session.prompt("explicit new input");
		expect(harness.faux.state.callCount).toBe(1);
		expect(backgroundTasks.get(directory, owner, task.runId)?.acknowledged).toBe(true);
	});

	it("does not let a child completing after stop wake the parent until the next real input", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "kalo-stop-child-"));
		directories.push(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const harness = await createHarness({ extensionFactories: [registerBackgroundNotifications] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("started")]);
		await harness.session.prompt("start task");
		const owner = harness.sessionManager.getSessionId();
		const directory = childSessionDir(harness.tempDir, owner, agentDir);
		const release = deferred<{ text: string }>();
		const task = backgroundTasks.start({ directory, owner, childId: "late-child", run: () => release.promise });
		await harness.session.abort();
		release.resolve({ text: "late result" });
		await setImmediate();
		await setImmediate();
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		expect(backgroundTasks.get(directory, owner, task.runId)?.acknowledged).toBe(false);
		harness.appendResponses([fauxAssistantMessage("continue explicitly")]);
		await harness.session.prompt("continue explicitly");
		expect(harness.faux.state.callCount).toBe(2);
		expect(backgroundTasks.get(directory, owner, task.runId)?.acknowledged).toBe(true);
	});

	it("cancels prompt preflight before any provider call", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		let first = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (!first) return;
						first = false;
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("next explicit request")]);
		await harness.session.bindExtensions({});
		const prompt = harness.session.prompt("cancel before dispatch");
		await entered.promise;
		await harness.session.abort();
		release.resolve();
		await expect(prompt).rejects.toThrow("Operation cancelled");
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.prompt("next explicit request");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("aborts an active provider request and drops queued continuations", async () => {
		const entered = deferred<void>();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async (_context, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
			fauxAssistantMessage("must not continue"),
		]);
		const running = harness.session.prompt("start generation");
		await entered.promise;
		await harness.session.followUp("queued message");
		await harness.session.abort();
		await running;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("clears a follow-up at agent_end and does not create a fresh uncancelled loop", async () => {
		let first = true;
		let abort: Promise<void> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (!first) return;
						first = false;
						pi.sendMessage(
							{ customType: "late", content: "must not continue", display: true },
							{ deliverAs: "followUp", triggerTurn: true },
						);
						abort = harness.session.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("unexpected continuation")]);
		await harness.session.bindExtensions({});
		await harness.session.prompt("first request");
		await abort;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.isIdle).toBe(true);
	});

	it("fences cancellation during asynchronous post-run work", async () => {
		const control = new RunCancellation();
		const entered = deferred<void>();
		const release = deferred<boolean>();
		let continuations = 0;
		const running = control.run(
			async () => {},
			async () => {
				entered.resolve();
				return release.promise;
			},
			async () => {
				continuations++;
			},
		);
		await entered.promise;
		control.cancel();
		release.resolve(true);
		await running;
		expect(continuations).toBe(0);
	});
});
