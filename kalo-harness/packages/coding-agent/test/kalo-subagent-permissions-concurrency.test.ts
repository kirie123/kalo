import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { acquireChild, Semaphore } from "../src/extensions/subagent/concurrency.ts";
import {
	CHILD_TOOLS_ENTRY,
	normalizeTools,
	persistChildTools,
	restoreChildTools,
	validateChildId,
} from "../src/extensions/subagent/tools.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "subagent-permissions-"));
	dirs.push(dir);
	return dir;
}

describe("subagent permissions", () => {
	it("normalizes comma/space strings, deduplicates, and preserves explicit empty permissions", () => {
		expect(normalizeTools("read, grep\nweb_fetch read")).toEqual(["read", "grep", "web_fetch"]);
		expect(normalizeTools(["read", "read", " bash "])).toEqual(["read", "bash"]);
		expect(normalizeTools([])).toEqual([]);
		expect(normalizeTools(" , ")).toEqual([]);
		expect(normalizeTools()).toContain("web_fetch");
		expect(() => normalizeTools("read,agent")).toThrow("未知");
		expect(() => normalizeTools(["read", 7])).toThrow("未知");
	});
	it("restores exact persisted permissions and fails closed on corrupt metadata", () => {
		const dir = directory();
		persistChildTools(dir, "subagent-1", ["read"]);
		expect(restoreChildTools(dir, "subagent-1")).toEqual(["read"]);
		writeFileSync(join(dir, "subagent-1.tools.json"), "broken");
		expect(() => restoreChildTools(dir, "subagent-1")).toThrow();
	});
	it("uses a legacy custom entry but never infers capabilities from history", () => {
		const dir = directory();
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(CHILD_TOOLS_ENTRY, { tools: ["grep"] });
		expect(restoreChildTools(dir, "subagent-2", manager.getEntries())).toEqual(["grep"]);
		expect(restoreChildTools(dir, "subagent-3")).toEqual([]);
		expect(() => validateChildId("../subagent-1")).toThrow();
		expect(() => validateChildId("subagent-1\\escape")).toThrow();
	});
});

describe("subagent concurrency", () => {
	it("cancels a queued waiter without taking a slot, and transfers slots FIFO", async () => {
		const slots = new Semaphore(1);
		const first = await slots.acquire();
		const controller = new AbortController();
		const cancelled = slots.acquire(controller.signal);
		const rejection = expect(cancelled).rejects.toThrow();
		const second = slots.acquire();
		controller.abort();
		await rejection;
		first();
		first();
		const releaseSecond = await second;
		let thirdAcquired = false;
		const third = slots.acquire().then((release) => {
			thirdAcquired = true;
			return release;
		});
		await Promise.resolve();
		expect(thirdAcquired).toBe(false);
		releaseSecond();
		(await third)();
	});
	it("rejects pre-aborted acquisition and allows independent children", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => new Semaphore(1).acquire(controller.signal)).toThrow();
		const first = await acquireChild("a");
		const other = await acquireChild("b");
		let acquired = false;
		const second = acquireChild("a").then((release) => {
			acquired = true;
			return release;
		});
		await Promise.resolve();
		expect(acquired).toBe(false);
		other();
		first();
		(await second)();
		(await acquireChild("a"))();
	});
});
