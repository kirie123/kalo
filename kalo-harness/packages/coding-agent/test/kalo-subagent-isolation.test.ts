import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, SessionManager } from "../src/core/session-manager.ts";

/**
 * Children live in `<cwd bucket>/subagent/<parent>/` so they stay out of the
 * user's conversation list. That guarantee rests entirely on session discovery
 * being non-recursive, which is an invariant of code this feature does not own.
 *
 * This test is the tripwire: if anyone makes session scanning recursive, every
 * child conversation would surface in the desktop sidebar, and this fails.
 *
 * Design: doc/2026-09-11-可续写子agent与主agent派生.md
 */
describe("subagent sessions stay out of the conversation list", () => {
	let bucket: string;

	beforeEach(() => {
		bucket = join(tmpdir(), `pi-kalo-bucket-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(bucket, { recursive: true });
	});

	afterEach(() => {
		if (bucket && existsSync(bucket)) rmSync(bucket, { recursive: true, force: true });
	});

	/** A minimal valid session file: one header line. */
	function writeSession(path: string, id: string): void {
		mkdirSync(join(path, ".."), { recursive: true });
		const header = {
			type: "session",
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
			cwd: "/repo",
		};
		writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
	}

	it("does not discover child sessions nested under subagent/", () => {
		writeSession(join(bucket, "parent.jsonl"), "parent-1");
		writeSession(join(bucket, "subagent", "parent-1", "subagent-1.jsonl"), "subagent-1");
		writeSession(join(bucket, "subagent", "parent-1", "subagent-2.jsonl"), "subagent-2");

		const found = findMostRecentSession(bucket);
		expect(found).not.toBeNull();
		expect(found!.replaceAll("\\", "/")).toContain("/parent.jsonl");
	});

	it("lists only the parent session in the bucket", async () => {
		writeSession(join(bucket, "parent.jsonl"), "parent-1");
		writeSession(join(bucket, "subagent", "parent-1", "subagent-1.jsonl"), "subagent-1");

		const sessions = await SessionManager.list("/repo", bucket);
		const ids = sessions.map((s) => s.id ?? "");
		expect(ids).toContain("parent-1");
		expect(ids).not.toContain("subagent-1");
	});

	// With no parent session present, an empty bucket must stay empty rather
	// than falling through to a child: that would resume the wrong conversation.
	it("finds nothing when the bucket holds only children", () => {
		writeSession(join(bucket, "subagent", "parent-1", "subagent-1.jsonl"), "subagent-1");
		expect(findMostRecentSession(bucket)).toBeNull();
	});
});
