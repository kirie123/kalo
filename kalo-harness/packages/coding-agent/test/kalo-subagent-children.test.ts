import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	_internals,
	type ChildHandle,
	childSessionDir,
	childTranscriptPath,
	findChildSessionFile,
	hasPersisted,
	lookup,
	nextChildId,
	register,
	resetRegistry,
	residentIds,
} from "../src/extensions/subagent/children.ts";

/**
 * The child registry keeps resident sessions and fences resume by owner. These
 * tests pin the path scheme, the ownership fence, and LRU eviction — the parts
 * that must hold without a real AgentSession or model.
 *
 * Design: doc/2026-09-11-可续写子agent与主agent派生.md
 */
describe("subagent children registry", () => {
	afterEach(() => resetRegistry());

	// A fake session: the registry never touches its methods, only holds it.
	const fakeSession = {} as AgentSession;

	function makeHandle(id: string, owner: string, lastActiveAt: number): ChildHandle {
		return {
			id,
			session: fakeSession,
			status: "idle",
			cwd: "/repo",
			ownerSession: owner,
			tools: ["read"],
			turns: 1,
			createdAt: 0,
			lastActiveAt,
		};
	}

	describe("session paths", () => {
		// Children must live under the parent's cwd bucket, in a subdirectory
		// keyed by parent session id — that subdirectory is what keeps them out
		// of the desktop's conversation list and fences resume by path.
		it("nests under the cwd bucket, subagent/<parent>/", () => {
			const d = childSessionDir("/repo", "parent-abc", "/agent").replaceAll("\\", "/");
			expect(d).toContain("/sessions/");
			expect(d).toContain("/subagent/parent-abc");
		});

		it("puts the transcript in that directory", () => {
			const t = childTranscriptPath("/repo", "parent-abc", "subagent-2", "/agent");
			expect(t.replaceAll("\\", "/")).toContain("/subagent/parent-abc/subagent-2.md");
		});

		// Two parents in the same cwd must not collide.
		it("separates children of different parents", () => {
			expect(childSessionDir("/repo", "parent-a", "/agent")).not.toBe(
				childSessionDir("/repo", "parent-b", "/agent"),
			);
		});
	});

	// SessionManager names session files `<timestamp>_<sessionId>.jsonl` and owns
	// that choice. Assuming a bare `<childId>.jsonl` made hasPersisted always
	// false, so resume-after-eviction silently reported "unknown child" even
	// though the history was on disk. A live run caught it; these pin the fix.
	describe("locating a persisted child", () => {
		let agentDir: string;

		afterEach(() => {
			if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		});

		function seed(childId: string, stamp = "2026-09-11T15-57-48-385Z"): string {
			agentDir ??= join(tmpdir(), `pi-kalo-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const dir = childSessionDir("/repo", "parent-a", agentDir);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${stamp}_${childId}.jsonl`);
			writeFileSync(file, "{}\n");
			return file;
		}

		it("finds the timestamped file SessionManager actually writes", () => {
			const file = seed("subagent-1");
			expect(findChildSessionFile("/repo", "parent-a", "subagent-1", agentDir)).toBe(file);
			expect(hasPersisted("/repo", "parent-a", "subagent-1", agentDir)).toBe(true);
		});

		// subagent-1 must not match subagent-10's file, nor vice versa.
		it("does not confuse subagent-1 with subagent-10", () => {
			seed("subagent-10");
			expect(findChildSessionFile("/repo", "parent-a", "subagent-1", agentDir)).toBeUndefined();
			expect(findChildSessionFile("/repo", "parent-a", "subagent-10", agentDir)).toBeDefined();
		});

		it("prefers the newest file when an id has several", () => {
			seed("subagent-1", "2026-09-11T10-00-00-000Z");
			const newer = seed("subagent-1", "2026-09-11T20-00-00-000Z");
			expect(findChildSessionFile("/repo", "parent-a", "subagent-1", agentDir)).toBe(newer);
		});

		it("reports absent when the directory does not exist", () => {
			agentDir ??= join(tmpdir(), `pi-kalo-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			expect(findChildSessionFile("/repo", "nobody", "subagent-1", agentDir)).toBeUndefined();
			expect(hasPersisted("/repo", "nobody", "subagent-1", agentDir)).toBe(false);
		});
	});

	describe("id allocation", () => {
		it("hands out monotonic subagent-N ids", () => {
			expect(nextChildId()).toBe("subagent-1");
			expect(nextChildId()).toBe("subagent-2");
		});
	});

	describe("ownership fence", () => {
		it("finds a child for its owner", () => {
			register(makeHandle("subagent-1", "parent-a", 1));
			expect(lookup("subagent-1", "parent-a")?.id).toBe("subagent-1");
		});

		// A foreign child is reported absent, not forbidden: ids are guessable,
		// so a distinct answer would leak that another conversation owns it.
		it("hides a child from another parent", () => {
			register(makeHandle("subagent-1", "parent-a", 1));
			expect(lookup("subagent-1", "parent-b")).toBeUndefined();
		});

		it("returns undefined for an unknown id", () => {
			expect(lookup("subagent-9", "parent-a")).toBeUndefined();
		});
	});

	describe("LRU eviction", () => {
		// Idle children over the cap are dropped oldest-first; history is on
		// disk, so an evicted child is still resumable, just not resident.
		it("evicts the least-recently-active idle children past the cap", () => {
			for (let i = 1; i <= 20; i++) {
				register(makeHandle(`subagent-${i}`, "parent-a", i));
			}
			_internals.evictIfNeeded();
			const ids = residentIds();
			expect(ids.length).toBe(16);
			// Oldest (lowest lastActiveAt) go first: 1..4 evicted, 5..20 kept.
			expect(ids).not.toContain("subagent-1");
			expect(ids).not.toContain("subagent-4");
			expect(ids).toContain("subagent-5");
			expect(ids).toContain("subagent-20");
		});

		// A running child holds an in-flight turn; evicting it would strand that
		// work, so the map is allowed to exceed the cap until it goes idle.
		it("never evicts a running child even past the cap", () => {
			for (let i = 1; i <= 20; i++) {
				const h = makeHandle(`subagent-${i}`, "parent-a", i);
				h.status = "running";
				register(h);
			}
			_internals.evictIfNeeded();
			expect(residentIds().length).toBe(20);
		});
	});
});
