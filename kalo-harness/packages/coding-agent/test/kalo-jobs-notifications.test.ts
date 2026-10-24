import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { type JobSnapshot, JobsClient } from "../src/extensions/kalo-jobs/client.ts";
import kaloJobsExtension from "../src/extensions/kalo-jobs/index.ts";

function setup() {
	vi.useFakeTimers();
	vi.spyOn(JobsClient.prototype, "available").mockReturnValue(true);
	const claim = vi.spyOn(JobsClient.prototype, "claimCompletions").mockResolvedValue([]);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const send = vi.fn();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		registerTool: () => {},
		sendMessage: send,
	} as unknown as ExtensionAPI;
	const context = (owner: string) =>
		({
			sessionManager: { getSessionId: () => owner },
			isIdle: () => true,
		}) as unknown as ExtensionContext;
	let ctx = context("first");
	const emit = (type: string, event: object = {}) => handlers.get(type)?.({ type, ...event }, ctx);
	kaloJobsExtension(pi);
	emit("session_start");
	const input = () => {
		emit("input", { source: "rpc", text: "continue" });
		emit("message_end", { message: { role: "user" } });
	};
	return {
		claim,
		send,
		emit,
		input,
		switchSession: () => {
			emit("session_shutdown");
			ctx = context("second");
			emit("session_start");
		},
	};
}

function job(id: string): JobSnapshot {
	return { id, label: id, kind: "bash", status: "completed", startedAt: 1, reported: true };
}

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("job completion notification activation", () => {
	it("does not claim old results on history open or extension input", async () => {
		const h = setup();
		await vi.advanceTimersByTimeAsync(15_000);
		h.emit("input", { source: "extension", text: "background" });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.claim).not.toHaveBeenCalled();
		expect(h.send).not.toHaveBeenCalled();
		h.claim.mockResolvedValueOnce([job("old-result")]);
		h.input();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.send).toHaveBeenCalledOnce();
		expect(h.send.mock.calls[0][0].content).toContain("old-result");
		expect(h.send.mock.calls[0][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("keeps a claimed result arriving after stop for the next real input", async () => {
		const h = setup();
		let resolve!: (jobs: JobSnapshot[]) => void;
		h.claim.mockReturnValueOnce(
			new Promise<JobSnapshot[]>((done) => {
				resolve = done;
			}),
		);
		h.input();
		h.emit("session_abort");
		resolve([job("late-result")]);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(h.send).not.toHaveBeenCalled();
		expect(h.claim).toHaveBeenCalledTimes(1);
		h.input();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.send).toHaveBeenCalledOnce();
		expect(h.send.mock.calls[0][0].content).toContain("late-result");
	});

	it("does not send an old session's in-flight completion to the replacement", async () => {
		const h = setup();
		let resolve!: (jobs: JobSnapshot[]) => void;
		h.claim.mockReturnValueOnce(
			new Promise<JobSnapshot[]>((done) => {
				resolve = done;
			}),
		);
		h.input();
		h.switchSession();
		resolve([job("private-old-result")]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.send).not.toHaveBeenCalled();
		h.claim.mockResolvedValueOnce([job("new-result")]);
		h.input();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.send).toHaveBeenCalledOnce();
		expect(h.send.mock.calls[0][0].content).not.toContain("private-old-result");
	});

	it("counts every delivery against the bounded wake budget and resets on new user input", async () => {
		const h = setup();
		h.claim.mockResolvedValue([job("result")]);
		h.input();
		await vi.advanceTimersByTimeAsync(25_000);
		expect(h.send).toHaveBeenCalledTimes(3);
		h.input();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.send).toHaveBeenCalledTimes(4);
	});
});
