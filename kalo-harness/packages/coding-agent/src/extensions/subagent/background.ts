/**
 * Process-owned background runs. The caller supplies the parent's existing
 * subagent directory and owns scheduling, permissions and notification delivery.
 * Design: doc/2026-10-13-后台子agent生命周期与可靠投递.md
 *
 * All public operations are synchronous except the supplied executor. Records
 * and events are snapshots. subscribe() observes process-wide events; consumers
 * must filter directory/owner and unsubscribe when their session detaches.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface BackgroundTaskResult {
	text: string;
	failed?: string;
	aborted?: boolean;
	stalled?: boolean;
	transcriptPath?: string;
}

export interface BackgroundTaskRecord {
	version: 1;
	runId: string;
	owner: string;
	childId: string;
	description?: string;
	status: BackgroundTaskStatus;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	finishedAt?: number;
	cancelRequestedAt?: number;
	acknowledged: boolean;
	result?: BackgroundTaskResult;
	/** Transient diagnostic, never persisted or interpreted as completion. */
	persistenceError?: string;
}

export interface BackgroundTaskStart {
	/** Existing subagent/<parentSessionId> directory, not a global storage root. */
	directory: string;
	owner: string;
	childId: string;
	description?: string;
	run: (signal: AbortSignal) => Promise<BackgroundTaskResult>;
}

export type BackgroundTaskEvent =
	| { type: "change"; directory: string; record: BackgroundTaskRecord }
	| { type: "error"; directory: string; owner: string; runId?: string; operation: "read" | "write"; error: Error };

export type BackgroundTaskListener = (event: BackgroundTaskEvent) => void;

type LiveTask = {
	directory: string;
	record: BackgroundTaskRecord;
	controller: AbortController;
	executing: boolean;
	/** Suppress reentrant retries from error listeners. */
	writing?: boolean;
	/** An uncommitted transition, including the complete executor result. */
	pending?: BackgroundTaskRecord;
	persistenceError?: string;
};

// Shared by every manager in this process: reopening a session or constructing
// a new manager must not turn another instance's active run into interrupted.
const live = new Map<string, LiveTask>();
const listeners = new Set<BackgroundTaskListener>();
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const statuses = new Set<BackgroundTaskStatus>([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);

function terminal(status: BackgroundTaskStatus): boolean {
	return status !== "queued" && status !== "running";
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validResult(value: unknown): value is BackgroundTaskResult {
	return (
		object(value) &&
		typeof value.text === "string" &&
		(value.failed === undefined || typeof value.failed === "string") &&
		(value.aborted === undefined || typeof value.aborted === "boolean") &&
		(value.stalled === undefined || typeof value.stalled === "boolean") &&
		(value.transcriptPath === undefined || typeof value.transcriptPath === "string")
	);
}

/** Validate disk data before using it for recovery, routing or acknowledgement. */
export function isBackgroundTaskRecord(value: unknown): value is BackgroundTaskRecord {
	if (
		!object(value) ||
		value.version !== 1 ||
		typeof value.runId !== "string" ||
		!runIdPattern.test(value.runId) ||
		typeof value.owner !== "string" ||
		!value.owner.trim() ||
		typeof value.childId !== "string" ||
		!value.childId.trim() ||
		(value.description !== undefined && typeof value.description !== "string") ||
		!statuses.has(value.status as BackgroundTaskStatus) ||
		!timestamp(value.createdAt) ||
		!timestamp(value.updatedAt) ||
		value.updatedAt < value.createdAt ||
		typeof value.acknowledged !== "boolean" ||
		value.persistenceError !== undefined
	) {
		return false;
	}
	for (const field of ["startedAt", "finishedAt", "cancelRequestedAt"] as const) {
		const time = value[field];
		if (time !== undefined && (!timestamp(time) || time < value.createdAt || time > value.updatedAt)) return false;
	}
	if (value.status === "queued" && value.startedAt !== undefined) return false;
	if (value.status === "running" && value.startedAt === undefined) return false;
	if (terminal(value.status as BackgroundTaskStatus)) {
		return value.finishedAt !== undefined && validResult(value.result);
	}
	return value.finishedAt === undefined && value.result === undefined && !value.acknowledged;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function missing(error: unknown): boolean {
	return object(error) && error.code === "ENOENT";
}

function canonicalDirectory(directory: string): string {
	if (!directory.trim()) throw new Error("Background task directory is required");
	let absolute = resolve(directory);
	try {
		absolute = realpathSync.native(absolute);
	} catch (error) {
		if (!missing(error)) throw error;
	}
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function recordPath(directory: string, runId: string): string {
	return join(directory, `background-${runId}.json`);
}

function emit(event: BackgroundTaskEvent): void {
	if (event.type === "error" && listeners.size === 0) console.error("[subagent background]", event.error);
	for (const listener of [...listeners]) {
		try {
			listener(structuredClone(event));
		} catch (error) {
			// An observer cannot roll back a durable result or prevent other observers.
			console.error("[subagent background] listener failed", error);
		}
	}
}

/** Same-directory rename replaces atomically on Windows and macOS; no shell. */
function writeRecord(directory: string, record: BackgroundTaskRecord): void {
	if (!isBackgroundTaskRecord(record)) throw new Error("Invalid background task record");
	const path = recordPath(directory, record.runId);
	const temp = `${path}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Preserve the original write error.
			}
		}
		try {
			unlinkSync(temp);
		} catch (cleanupError) {
			if (!missing(cleanupError))
				throw new AggregateError([error, cleanupError], "Background task write and cleanup failed");
		}
		throw error;
	}
}

function snapshot(task: LiveTask): BackgroundTaskRecord {
	const record = structuredClone(task.record);
	if (task.persistenceError) record.persistenceError = task.persistenceError;
	return record;
}

/** Retain a failed write in memory. No change event exists until it is durable. */
function commit(task: LiveTask, record: BackgroundTaskRecord): void {
	task.writing = true;
	try {
		writeRecord(task.directory, record);
	} catch (error) {
		task.pending = record;
		task.persistenceError = asError(error).message;
		emit({
			type: "error",
			directory: task.directory,
			owner: record.owner,
			runId: record.runId,
			operation: "write",
			error: asError(error),
		});
		throw error;
	} finally {
		task.writing = false;
	}
	task.record = record;
	task.pending = undefined;
	task.persistenceError = undefined;
	if (!task.executing && terminal(record.status)) live.delete(recordPath(task.directory, record.runId));
	emit({ type: "change", directory: task.directory, record });
}

function retry(task: LiveTask): void {
	if (!task.pending || task.writing) return;
	try {
		commit(task, task.pending);
	} catch {
		// commit exposes the failure via the error event and snapshot diagnostic.
	}
}

function timeAfter(record: BackgroundTaskRecord): number {
	return Math.max(Date.now(), record.updatedAt);
}

async function execute(task: LiveTask, run: BackgroundTaskStart["run"]): Promise<void> {
	if (terminal(task.record.status)) return; // Cancelled before its microtask ran.
	if (task.controller.signal.aborted && task.pending && terminal(task.pending.status)) {
		retry(task);
		return;
	}
	task.executing = true;
	let result: BackgroundTaskResult;
	try {
		const now = timeAfter(task.record);
		commit(task, { ...task.record, status: "running", startedAt: now, updatedAt: now });
		if (task.controller.signal.aborted) {
			result = { text: "", aborted: true };
		} else {
			const output = await run(task.controller.signal);
			if (!validResult(output)) throw new Error("Invalid background task executor result");
			result = {
				text: output.text,
				failed: output.failed,
				aborted: output.aborted,
				stalled: output.stalled,
				transcriptPath: output.transcriptPath,
			};
		}
	} catch (error) {
		result = { text: "", failed: asError(error).message };
	}
	task.executing = false;
	const previous = task.pending ?? task.record;
	const now = timeAfter(previous);
	const cancelled = task.controller.signal.aborted || result.aborted;
	const status = cancelled ? "cancelled" : result.failed !== undefined || result.stalled ? "failed" : "completed";
	try {
		commit(task, { ...previous, status, result, updatedAt: now, finishedAt: now });
	} catch {
		// The executor's result remains in task.pending; list/get retry it.
	}
}

export class BackgroundTasks {
	/** Persist queued synchronously, then launch independently of the calling turn. */
	start(input: BackgroundTaskStart): BackgroundTaskRecord {
		if (!input.owner.trim() || !input.childId.trim() || typeof input.run !== "function") {
			throw new Error("Background task owner, childId and executor are required");
		}
		mkdirSync(input.directory, { recursive: true });
		const directory = canonicalDirectory(input.directory);
		const now = Date.now();
		const record: BackgroundTaskRecord = {
			version: 1,
			runId: randomUUID(),
			owner: input.owner,
			childId: input.childId,
			description: input.description,
			status: "queued",
			createdAt: now,
			updatedAt: now,
			acknowledged: false,
		};
		try {
			writeRecord(directory, record);
		} catch (error) {
			emit({
				type: "error",
				directory,
				owner: input.owner,
				runId: record.runId,
				operation: "write",
				error: asError(error),
			});
			throw error; // A failed registration never starts the executor.
		}
		const task: LiveTask = { directory, record, controller: new AbortController(), executing: false };
		live.set(recordPath(directory, record.runId), task);
		const run = input.run;
		queueMicrotask(() => void execute(task, run));
		emit({ type: "change", directory, record });
		return structuredClone(record);
	}

	/** Active = queued/running; pending delivery = terminal && !acknowledged. */
	list(directory: string, owner: string): BackgroundTaskRecord[] {
		const canonical = canonicalDirectory(directory);
		const records = new Map<string, BackgroundTaskRecord>();
		let names: string[];
		try {
			names = readdirSync(canonical);
		} catch (error) {
			if (!missing(error)) throw error;
			names = [];
		}
		for (const name of names) {
			if (!name.startsWith("background-") || !name.endsWith(".json")) continue;
			const runId = name.slice("background-".length, -".json".length);
			if (!runIdPattern.test(runId)) continue;
			const record = this.load(canonical, owner, runId);
			if (record) records.set(runId, record);
		}
		// Keep failed final writes visible even if the directory/file was removed.
		for (const task of [...live.values()]) {
			if (task.directory !== canonical || task.record.owner !== owner) continue;
			if (!records.has(task.record.runId)) {
				retry(task);
				records.set(task.record.runId, snapshot(task));
			}
		}
		return [...records.values()].sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
	}

	get(directory: string, owner: string, runId: string): BackgroundTaskRecord | undefined {
		if (!runIdPattern.test(runId)) return undefined;
		return this.load(canonicalDirectory(directory), owner, runId);
	}

	/** Queued cancellation is immediate; running cancellation waits for executor settlement. */
	cancel(directory: string, owner: string, runId: string): BackgroundTaskRecord | undefined {
		const canonical = canonicalDirectory(directory);
		const record = this.get(canonical, owner, runId);
		if (!record || terminal(record.status)) return record;
		const task = live.get(recordPath(canonical, runId));
		if (!task) return record;
		const previous = task.pending ?? task.record;
		if (terminal(previous.status)) return snapshot(task);
		const now = timeAfter(previous);
		const next: BackgroundTaskRecord = { ...previous, cancelRequestedAt: now, updatedAt: now };
		if (!task.executing) {
			next.status = "cancelled";
			next.finishedAt = now;
			next.result = { text: "", aborted: true };
		}
		try {
			commit(task, next);
		} finally {
			task.controller.abort(); // Never linked to a parent tool's AbortSignal.
		}
		return snapshot(task);
	}

	/** Call only after actual delivery acknowledgement. Active runs cannot be acked. */
	ack(directory: string, owner: string, runId: string): BackgroundTaskRecord | undefined {
		const canonical = canonicalDirectory(directory);
		const record = this.get(canonical, owner, runId);
		if (!record || record.acknowledged) return record;
		if (!terminal(record.status) || record.persistenceError)
			throw new Error("Background task result is not durable yet");
		const task: LiveTask = {
			directory: canonical,
			record,
			controller: new AbortController(),
			executing: false,
		};
		// Ack failure must leave the result pending on disk; it can be retried by
		// another ack call, but must not be silently retried as a delivery receipt.
		commit(task, { ...record, acknowledged: true, updatedAt: timeAfter(record) });
		return snapshot(task);
	}

	subscribe(listener: BackgroundTaskListener): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	private load(directory: string, owner: string, runId: string): BackgroundTaskRecord | undefined {
		const path = recordPath(directory, runId);
		const active = live.get(path);
		if (active) {
			if (active.record.owner !== owner) return undefined;
			retry(active);
			return snapshot(active);
		}
		let record: BackgroundTaskRecord;
		try {
			const data: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isBackgroundTaskRecord(data) || data.runId !== runId)
				throw new Error(`Invalid background task record: ${path}`);
			if (data.owner !== owner) return undefined;
			record = data;
		} catch (error) {
			if (missing(error)) return undefined;
			emit({ type: "error", directory, owner, runId, operation: "read", error: asError(error) });
			return undefined;
		}
		if (terminal(record.status)) return structuredClone(record);
		const task: LiveTask = { directory, record, controller: new AbortController(), executing: false };
		live.set(path, task);
		const now = timeAfter(record);
		try {
			commit(task, {
				...record,
				status: "interrupted",
				updatedAt: now,
				finishedAt: now,
				result: { text: "", failed: "Engine stopped before the background task finished; resume explicitly." },
			});
		} catch {
			// Preserve the failed recovery write for the same retry path as results.
		}
		return snapshot(task);
	}
}

export const backgroundTasks = new BackgroundTasks();
