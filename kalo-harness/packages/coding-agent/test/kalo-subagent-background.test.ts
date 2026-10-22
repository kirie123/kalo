import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundTaskEvent,
	type BackgroundTaskRecord,
	type BackgroundTaskResult,
	BackgroundTasks,
	isBackgroundTaskRecord,
} from "../src/extensions/subagent/background.ts";

function deferred() {
	let resolve!: (result: BackgroundTaskResult) => void;
	const promise = new Promise<BackgroundTaskResult>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

describe("background subagent persistence and lifecycle", () => {
	let directory: string;
	let manager: BackgroundTasks;
	let events: BackgroundTaskEvent[];
	let unsubscribe: () => void;
	const owner = "parent-a";

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "kalo-background-"));
		manager = new BackgroundTasks();
		events = [];
		unsubscribe = manager.subscribe((event) => events.push(event));
	});

	afterEach(() => {
		unsubscribe();
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function path(runId: string): string {
		return join(directory, `background-${runId}.json`);
	}

	function disk(runId: string): BackgroundTaskRecord {
		const data: unknown = JSON.parse(readFileSync(path(runId), "utf8"));
		if (!isBackgroundTaskRecord(data)) throw new Error("Invalid test record");
		return data;
	}

	function start(run: (signal: AbortSignal) => Promise<BackgroundTaskResult>, childId = "child-1") {
		return manager.start({ directory, owner, childId, description: "test task", run });
	}

	function seed(status: "queued" | "running", recordOwner = owner): BackgroundTaskRecord {
		const record: BackgroundTaskRecord = {
			version: 1,
			runId: randomUUID(),
			childId: "old-child",
			owner: recordOwner,
			status,
			createdAt: 10,
			updatedAt: 20,
			startedAt: status === "running" ? 20 : undefined,
			acknowledged: false,
		};
		writeFileSync(path(record.runId), JSON.stringify(record));
		return record;
	}

	it("registers before returning, generates independent run ids, and persists before notifying", async () => {
		const done = deferred();
		const run = vi.fn(() => done.promise);
		const observed: BackgroundTaskRecord[] = [];
		const off = manager.subscribe((event) => {
			if (event.type === "change") observed.push(disk(event.record.runId));
		});
		try {
			const first = start(run);
			const second = start(async () => ({ text: "second" }));
			expect(first.status).toBe("queued");
			expect(first.runId).not.toBe(second.runId);
			expect(first.runId).not.toBe(first.childId);
			expect(disk(first.runId)).toEqual(first);
			expect(run).not.toHaveBeenCalled();
			await setImmediate();
			expect(disk(first.runId).status).toBe("running");
			done.resolve({ text: "完整结果", transcriptPath: join(directory, "child.md") });
			await setImmediate();
			expect(manager.get(directory, owner, first.runId)?.result).toEqual({
				text: "完整结果",
				transcriptPath: join(directory, "child.md"),
			});
			expect(observed.map((record) => record.status)).toContain("completed");
			expect(observed.filter((record) => record.runId === first.runId).map((record) => record.status)).toEqual([
				"queued",
				"running",
				"completed",
			]);
			expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
		} finally {
			off();
		}
	});

	it("continues after the calling turn and subscription end; reopening keeps same-process runs active", async () => {
		const done = deferred();
		const parent = new AbortController();
		let childSignal: AbortSignal | undefined;
		const task = start((signal) => {
			childSignal = signal;
			return done.promise;
		});
		const reopened = new BackgroundTasks();
		expect(reopened.list(join(directory, "."), owner)[0].status).toBe("queued");
		await setImmediate();
		unsubscribe();
		parent.abort();
		expect(childSignal?.aborted).toBe(false);
		expect(reopened.list(directory, owner)[0].status).toBe("running");
		done.resolve({ text: "completed without the parent" });
		await setImmediate();
		expect(reopened.get(directory, owner, task.runId)).toMatchObject({
			status: "completed",
			acknowledged: false,
			result: { text: "completed without the parent" },
		});
	});

	it.each(["queued", "running"] as const)(
		"recovers a previous process's %s record once, without replaying work",
		(status) => {
			const task = seed(status);
			const restored = manager.list(directory, owner);
			expect(restored).toHaveLength(1);
			expect(restored[0]).toMatchObject({ runId: task.runId, status: "interrupted", acknowledged: false });
			expect(disk(task.runId)).toEqual(restored[0]);
			const count = events.length;
			expect(new BackgroundTasks().list(directory, owner)).toEqual(restored);
			expect(events).toHaveLength(count);
		},
	);

	it("fences reads, recovery, cancellation and ack by owner and directory", async () => {
		const done = deferred();
		let signal: AbortSignal | undefined;
		const task = start((value) => {
			signal = value;
			return done.promise;
		});
		const foreign = seed("queued", "parent-b");
		expect(manager.list(directory, owner).map((item) => item.runId)).toEqual([task.runId]);
		expect(disk(foreign.runId).status).toBe("queued");
		expect(manager.get(directory, "parent-b", task.runId)).toBeUndefined();
		expect(manager.cancel(directory, "parent-b", task.runId)).toBeUndefined();
		expect(manager.ack(directory, "parent-b", task.runId)).toBeUndefined();
		expect(manager.get(join(directory, "other"), owner, task.runId)).toBeUndefined();
		expect(manager.get(directory, owner, "../outside")).toBeUndefined();
		await setImmediate();
		expect(signal?.aborted).toBe(false);
		done.resolve({ text: "private result" });
		await setImmediate();
		expect(manager.get(directory, "parent-b", task.runId)).toBeUndefined();
		expect(manager.ack(directory, "parent-b", task.runId)).toBeUndefined();
		expect(disk(task.runId).acknowledged).toBe(false);
	});

	it("cancels queued work without invoking the executor", async () => {
		const run = vi.fn(async () => ({ text: "must not run" }));
		const task = start(run);
		expect(manager.ack.bind(manager, directory, owner, task.runId)).toThrow("not durable");
		expect(manager.cancel(directory, owner, task.runId)?.status).toBe("cancelled");
		await setImmediate();
		expect(run).not.toHaveBeenCalled();
		expect(disk(task.runId).result?.aborted).toBe(true);
	});

	it("cancels only the selected controller and waits for settlement before terminal notification", async () => {
		const firstDone = deferred();
		const secondDone = deferred();
		const signals: AbortSignal[] = [];
		const first = start((signal) => {
			signals.push(signal);
			return firstDone.promise;
		});
		const second = start((signal) => {
			signals.push(signal);
			return secondDone.promise;
		}, "child-2");
		await setImmediate();
		expect(manager.cancel(directory, owner, first.runId)).toMatchObject({
			status: "running",
			cancelRequestedAt: expect.any(Number),
		});
		expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
		expect(events.some((event) => event.type === "change" && event.record.status === "cancelled")).toBe(false);
		firstDone.resolve({ text: "partial output" });
		secondDone.resolve({ text: "unaffected" });
		await setImmediate();
		expect(disk(first.runId)).toMatchObject({ status: "cancelled", result: { text: "partial output" } });
		expect(disk(second.runId).status).toBe("completed");
		expect(manager.cancel(directory, owner, second.runId)?.status).toBe("completed");
	});

	it.each([
		[{ text: "ok" }, "completed"],
		[{ text: "partial", failed: "provider error" }, "failed"],
		[{ text: "partial", failed: "" }, "failed"],
		[{ text: "partial", stalled: true }, "failed"],
		[{ text: "partial", aborted: true }, "cancelled"],
	] as const)("maps executor result %j to %s", async (result, status) => {
		const task = start(async () => result);
		await setImmediate();
		expect(disk(task.runId)).toMatchObject({ status, result, acknowledged: false });
	});

	it("records executor rejection and invalid executor output as failed", async () => {
		const rejected = start(async () => {
			throw new Error("offline executor failure");
		});
		const invalid = start(async () => ({ text: 42 }) as unknown as BackgroundTaskResult);
		await setImmediate();
		expect(disk(rejected.runId)).toMatchObject({ status: "failed", result: { failed: "offline executor failure" } });
		expect(disk(invalid.runId)).toMatchObject({
			status: "failed",
			result: { failed: "Invalid background task executor result" },
		});
	});

	it("persists ack, keeps pending results across manager recreation and makes ack idempotent", async () => {
		const task = start(async () => ({ text: "notify later" }));
		await setImmediate();
		expect(new BackgroundTasks().list(directory, owner)[0].acknowledged).toBe(false);
		const acked = manager.ack(directory, owner, task.runId);
		expect(acked?.acknowledged).toBe(true);
		expect(disk(task.runId)).toEqual(acked);
		const count = events.length;
		expect(new BackgroundTasks().ack(directory, owner, task.runId)).toEqual(acked);
		expect(events).toHaveLength(count);
	});

	it("does not expose mutable records to callers or observers", async () => {
		const off = manager.subscribe((event) => {
			if (event.type === "change") event.record.owner = "intruder";
		});
		try {
			const task = start(async () => ({ text: "original" }));
			task.owner = "intruder";
			await setImmediate();
			const copy = manager.get(directory, owner, task.runId);
			if (copy?.result) copy.result.text = "changed";
			expect(manager.get(directory, owner, task.runId)?.result?.text).toBe("original");
		} finally {
			off();
		}
	});

	it("rejects corrupt and inconsistent records observably and ignores unrelated files", () => {
		const invalid = seed("queued");
		writeFileSync(path(invalid.runId), JSON.stringify({ ...invalid, acknowledged: true }));
		const corruptId = randomUUID();
		writeFileSync(path(corruptId), "{");
		const mismatchId = randomUUID();
		writeFileSync(path(mismatchId), JSON.stringify({ ...invalid, runId: randomUUID() }));
		writeFileSync(join(directory, "child.jsonl"), "{}");
		writeFileSync(`${path(randomUUID())}.tmp`, "{");
		expect(manager.list(directory, owner)).toEqual([]);
		expect(events.filter((event) => event.type === "error" && event.operation === "read")).toHaveLength(3);
		expect(isBackgroundTaskRecord({ ...invalid, owner: "" })).toBe(false);
		expect(isBackgroundTaskRecord({ ...invalid, updatedAt: -1 })).toBe(false);
		expect(isBackgroundTaskRecord({ ...invalid, status: "completed" })).toBe(false);
	});

	it("throws registration write failure and never runs the executor", async () => {
		// A file in place of the directory fails on Windows and POSIX without chmod.
		const blocked = join(directory, "blocked");
		writeFileSync(blocked, "not a directory");
		const run = vi.fn(async () => ({ text: "lost" }));
		expect(() => manager.start({ directory: blocked, owner, childId: "child", run })).toThrow();
		await setImmediate();
		expect(run).not.toHaveBeenCalled();
	});

	it("retains failed final writes, emits no false completion, then retries the exact result", async () => {
		const done = deferred();
		const task = start(() => done.promise);
		await setImmediate();
		const saved = `${path(task.runId)}.saved`;
		renameSync(path(task.runId), saved);
		mkdirSync(path(task.runId)); // rename-over-directory fails on both platforms.
		done.resolve({ text: "irreplaceable result", transcriptPath: "relative-transcript.md" });
		await setImmediate();
		const failed = manager.list(directory, owner)[0];
		expect(failed).toMatchObject({ status: "running", persistenceError: expect.any(String) });
		expect(events.some((event) => event.type === "error" && event.operation === "write")).toBe(true);
		expect(events.some((event) => event.type === "change" && event.record.status === "completed")).toBe(false);
		expect(() => manager.ack(directory, owner, task.runId)).toThrow("not durable");
		expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
		rmSync(path(task.runId), { recursive: true });
		renameSync(saved, path(task.runId));
		const recovered = new BackgroundTasks().get(directory, owner, task.runId);
		expect(recovered).toMatchObject({
			status: "completed",
			result: { text: "irreplaceable result", transcriptPath: "relative-transcript.md" },
		});
		expect(recovered?.persistenceError).toBeUndefined();
		expect(disk(task.runId)).toEqual(recovered);
		expect(events.filter((event) => event.type === "change" && event.record.status === "completed")).toHaveLength(1);
	});

	it("retains final output when the storage directory disappears", async () => {
		const done = deferred();
		const task = start(() => done.promise);
		await setImmediate();
		rmSync(directory, { recursive: true });
		done.resolve({ text: "survives missing storage" });
		await setImmediate();
		expect(manager.list(directory, owner)[0].persistenceError).toBeDefined();
		mkdirSync(directory);
		expect(manager.list(directory, owner)[0]).toMatchObject({
			status: "completed",
			result: { text: "survives missing storage" },
		});
		expect(disk(task.runId).status).toBe("completed");
	});

	it("does not launch work if persisting the running transition fails", async () => {
		const run = vi.fn(async () => ({ text: "must not run" }));
		const task = start(run);
		const saved = `${path(task.runId)}.saved`;
		renameSync(path(task.runId), saved);
		mkdirSync(path(task.runId));
		await setImmediate();
		expect(run).not.toHaveBeenCalled();
		expect(manager.get(directory, owner, task.runId)).toMatchObject({
			status: "queued",
			persistenceError: expect.any(String),
		});
		rmSync(path(task.runId), { recursive: true });
		renameSync(saved, path(task.runId));
		expect(manager.get(directory, owner, task.runId)?.status).toBe("failed");
	});

	it("keeps cancellation effective when its queued-state write fails", async () => {
		const run = vi.fn(async () => ({ text: "must not run" }));
		const task = start(run);
		const saved = `${path(task.runId)}.saved`;
		renameSync(path(task.runId), saved);
		mkdirSync(path(task.runId));
		expect(() => manager.cancel(directory, owner, task.runId)).toThrow();
		await setImmediate();
		expect(run).not.toHaveBeenCalled();
		rmSync(path(task.runId), { recursive: true });
		renameSync(saved, path(task.runId));
		expect(manager.get(directory, owner, task.runId)?.status).toBe("cancelled");
	});

	it("allows error observers to query state without recursive retries", async () => {
		const done = deferred();
		const task = start(() => done.promise);
		await setImmediate();
		const saved = `${path(task.runId)}.saved`;
		renameSync(path(task.runId), saved);
		mkdirSync(path(task.runId));
		const queries: BackgroundTaskRecord[][] = [];
		const off = manager.subscribe((event) => {
			if (event.type === "error") queries.push(manager.list(directory, owner));
		});
		try {
			done.resolve({ text: "preserved" });
			await setImmediate();
			expect(queries).toHaveLength(1);
			expect(queries[0][0].persistenceError).toBeDefined();
			rmSync(path(task.runId), { recursive: true });
			renameSync(saved, path(task.runId));
			expect(manager.get(directory, owner, task.runId)?.result?.text).toBe("preserved");
		} finally {
			off();
		}
	});

	it("isolates throwing observers from durable results and other observers", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const off = manager.subscribe(() => {
			throw new Error("broken observer");
		});
		try {
			const task = start(async () => ({ text: "still delivered" }));
			await setImmediate();
			expect(disk(task.runId).status).toBe("completed");
			expect(events.some((event) => event.type === "change" && event.record.status === "completed")).toBe(true);
			expect(log).toHaveBeenCalled();
		} finally {
			off();
		}
	});

	it("does not consume acknowledgement when its atomic write fails", async () => {
		const task = start(async () => ({ text: "deliver again" }));
		await setImmediate();
		const get = manager.get.bind(manager);
		const saved = `${path(task.runId)}.saved`;
		vi.spyOn(manager, "get").mockImplementationOnce((dir, taskOwner, id) => {
			const record = get(dir, taskOwner, id);
			renameSync(path(task.runId), saved);
			mkdirSync(path(task.runId));
			return record;
		});
		expect(() => manager.ack(directory, owner, task.runId)).toThrow();
		expect(events.some((event) => event.type === "change" && event.record.acknowledged)).toBe(false);
		rmSync(path(task.runId), { recursive: true });
		renameSync(saved, path(task.runId));
		expect(new BackgroundTasks().get(directory, owner, task.runId)?.acknowledged).toBe(false);
		expect(manager.ack(directory, owner, task.runId)?.acknowledged).toBe(true);
	});
});
