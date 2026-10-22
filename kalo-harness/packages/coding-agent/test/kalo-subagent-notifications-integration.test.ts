import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionError } from "../src/core/extensions/types.ts";
import {
	type BackgroundTaskRecord,
	type BackgroundTaskResult,
	backgroundTasks,
} from "../src/extensions/subagent/background.ts";
import { childSessionDir } from "../src/extensions/subagent/children.ts";
import { registerBackgroundNotifications } from "../src/extensions/subagent/notifications.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("background subagent notifications integration", () => {
	it.each(["idle", "busy"] as const)(
		"delivers to a %s parent through AgentSession and ACKs only after successful settlement",
		async (mode) => {
			const agentDir = mkdtempSync(join(tmpdir(), "kalo-notification-integration-"));
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			const mainStarted = deferred<void>();
			const mainRelease = deferred<void>();
			const childRelease = deferred<BackgroundTaskResult>();
			const notificationStarted = deferred<void>();
			const notificationRelease = deferred<void>();
			const notificationSettled = deferred<void>();
			const contexts: ExtensionContext[] = [];
			const trace: string[] = [];
			const ackAtMessageEnd: boolean[] = [];
			const ackBeforeSettled: boolean[] = [];
			const ackAfterSettled: boolean[] = [];
			const customDetails: unknown[] = [];
			const errors: ExtensionError[] = [];
			let providerMessages: string[] = [];
			let harness: Harness | undefined;
			let task: BackgroundTaskRecord | undefined;
			let directory = "";
			let owner = "";
			let mainPrompt: Promise<void> | undefined;
			let unsubscribe: (() => void) | undefined;
			const acknowledged = () =>
				task ? backgroundTasks.get(directory, owner, task.runId)?.acknowledged === true : false;

			try {
				harness = await createHarness({
					settings: { retry: { enabled: false }, compaction: { enabled: false } },
					extensionFactories: [
						(pi) => {
							// Observe before the notification handlers; assertions stay outside handlers
							// because ExtensionRunner deliberately catches their exceptions.
							pi.on("session_start", (_event, ctx) => {
								contexts.push(ctx);
							});
							pi.on("message_end", (event, ctx) => {
								contexts.push(ctx);
								ackAtMessageEnd.push(acknowledged());
								if (event.message.role === "custom") {
									trace.push(`custom:${event.message.customType}`);
									customDetails.push(event.message.details);
								} else if (event.message.role === "assistant") {
									trace.push(`assistant:${getMessageText(event.message)}`);
								}
							});
							pi.on("agent_settled", (_event, ctx) => {
								contexts.push(ctx);
								trace.push("settled");
								ackBeforeSettled.push(acknowledged());
							});
							registerBackgroundNotifications(pi);
							pi.on("agent_settled", () => {
								ackAfterSettled.push(acknowledged());
							});
						},
					],
				});
				const parent = harness;
				harness.setResponses([
					...(mode === "busy"
						? [
								async () => {
									mainStarted.resolve();
									await mainRelease.promise;
									return fauxAssistantMessage("original response");
								},
							]
						: []),
					async (context) => {
						providerMessages = context.messages.map(getMessageText);
						notificationStarted.resolve();
						await notificationRelease.promise;
						return fauxAssistantMessage("notification handled");
					},
				]);
				await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
				expect(harness.session.extensionRunner).toBeInstanceOf(ExtensionRunner);
				owner = harness.sessionManager.getSessionId();
				directory = childSessionDir(harness.tempDir, owner, agentDir);
				unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "agent_settled") notificationSettled.resolve();
				});

				if (mode === "busy") {
					mainPrompt = harness.session.prompt("finish the original request");
					await mainStarted.promise;
				} else {
					expect(harness.session.isIdle).toBe(true);
					expect(harness.faux.state.callCount).toBe(0);
				}
				task = backgroundTasks.start({
					directory,
					owner,
					childId: "integration-child",
					run: () => childRelease.promise,
				});
				await vi.waitFor(() => {
					expect(backgroundTasks.get(directory, owner, task!.runId)?.status).toBe("running");
				});
				childRelease.resolve({ text: "unique background child result" });

				if (mode === "busy") {
					await vi.waitFor(() => expect(parent.session.agent.hasQueuedMessages()).toBe(true));
					expect(harness.session.isStreaming).toBe(true);
					expect(harness.faux.state.callCount).toBe(1);
					expect(customDetails).toEqual([]);
					expect(acknowledged()).toBe(false);
					expect(backgroundTasks.get(directory, owner, task.runId)?.status).toBe("completed");
					mainRelease.resolve();
				}

				await notificationStarted.promise;
				expect(customDetails).toEqual([{ runIds: [task.runId] }]);
				expect(providerMessages.join("\n")).toContain("unique background child result");
				expect(acknowledged()).toBe(false);
				expect(ackBeforeSettled).toEqual([]);
				const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
				expect(entries).toEqual([
					expect.objectContaining({ customType: "kalo-subagent-done", details: { runIds: [task.runId] } }),
				]);

				notificationRelease.resolve();
				await notificationSettled.promise;
				await mainPrompt;
				await harness.session.waitForIdle();
				await setImmediate(); // Flush the post-ACK scan; it must not submit a duplicate turn.
				expect(trace).toEqual([
					...(mode === "busy" ? ["assistant:original response"] : []),
					"custom:kalo-subagent-done",
					"assistant:notification handled",
					"settled",
				]);
				expect(ackAtMessageEnd.every((ack) => !ack)).toBe(true);
				expect(ackBeforeSettled).toEqual([false]);
				expect(ackAfterSettled).toEqual([true]);
				expect(acknowledged()).toBe(true);
				const durableRecord: unknown = JSON.parse(
					readFileSync(join(directory, `background-${task.runId}.json`), "utf8"),
				);
				expect(durableRecord).toMatchObject({ runId: task.runId, status: "completed", acknowledged: true });
				expect(harness.faux.state.callCount).toBe(mode === "idle" ? 1 : 2);
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(contexts.length).toBeGreaterThanOrEqual(4);
				expect(new Set(contexts).size).toBe(contexts.length);
				expect(contexts.every((ctx) => ctx.sessionManager === parent.sessionManager)).toBe(true);
				expect(contexts.every((ctx) => ctx.cwd === parent.tempDir)).toBe(true);
				expect(errors).toEqual([]);
			} finally {
				if (harness) await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				mainRelease.resolve();
				notificationRelease.resolve();
				childRelease.resolve({ text: "cleanup" });
				await setImmediate();
				await harness?.session.abort();
				await mainPrompt;
				unsubscribe?.();
				harness?.cleanup();
				vi.unstubAllEnvs();
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
	);
});
