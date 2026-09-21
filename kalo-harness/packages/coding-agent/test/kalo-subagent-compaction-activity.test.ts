import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CompactionResult } from "../src/core/compaction/compaction.ts";
import {
	applyCompactionActivity,
	type ChildActivity,
	MAX_ACTIVITY_ITEMS,
	MAX_ACTIVITY_TEXT_CHARS,
	trimActivity,
} from "../src/extensions/subagent/activity.ts";

/**
 * A child agent compacts on its own, and the desktop card is the only place a
 * user could see it happen. These tests pin the feed entries the card renders.
 *
 * Design: doc/2026-09-18-子agent压缩气泡.md
 */

function started(reason: "manual" | "threshold" | "overflow" = "threshold"): AgentSessionEvent {
	return { type: "compaction_start", reason };
}

function ended(result: CompactionResult | undefined, extra: Partial<{ aborted: boolean; errorMessage: string }> = {}) {
	const event: AgentSessionEvent = {
		type: "compaction_end",
		reason: "threshold",
		result,
		aborted: false,
		willRetry: false,
		...extra,
	};
	return event;
}

function result(summary: string, tokensBefore = 185_196): CompactionResult {
	return { summary, firstKeptEntryId: "entry-1", tokensBefore };
}

describe("subagent compaction activity", () => {
	it("appends a running entry on compaction_start", () => {
		const activity: ChildActivity[] = [];

		applyCompactionActivity(activity, started("overflow"));

		expect(activity).toEqual([{ kind: "compaction", reason: "overflow", status: "running" }]);
	});

	it("settles the running entry in place with tokens and summary", () => {
		const activity: ChildActivity[] = [
			{ kind: "tool", toolCallId: "t1", name: "read", label: "a.ts", status: "success" },
		];
		applyCompactionActivity(activity, started());
		activity.push({ kind: "text", text: "继续" });

		applyCompactionActivity(activity, ended(result("压缩摘要")));

		expect(activity[1]).toEqual({
			kind: "compaction",
			reason: "threshold",
			status: "done",
			tokensBefore: 185_196,
			summary: "压缩摘要",
		});
		expect(activity).toHaveLength(3);
	});

	it("marks a cancelled compaction instead of dropping it", () => {
		const activity: ChildActivity[] = [];
		applyCompactionActivity(activity, started());

		applyCompactionActivity(activity, ended(undefined, { aborted: true }));

		expect(activity[0]).toMatchObject({ kind: "compaction", status: "failed", aborted: true });
	});

	it("keeps the failure reason", () => {
		const activity: ChildActivity[] = [];
		applyCompactionActivity(activity, started());

		applyCompactionActivity(activity, ended(undefined, { errorMessage: "Auto-compaction failed: 502" }));

		expect(activity[0]).toMatchObject({
			kind: "compaction",
			status: "failed",
			errorMessage: "Auto-compaction failed: 502",
		});
	});

	it("caps the summary at the activity text limit", () => {
		const activity: ChildActivity[] = [];
		applyCompactionActivity(activity, started());

		applyCompactionActivity(activity, ended(result("字".repeat(MAX_ACTIVITY_TEXT_CHARS + 500))));

		const entry = activity[0];
		if (entry.kind !== "compaction") throw new Error("expected a compaction entry");
		expect(entry.summary).toHaveLength(MAX_ACTIVITY_TEXT_CHARS + 1);
		expect(entry.summary?.endsWith("…")).toBe(true);
		expect(entry.summaryTruncated).toBe(true);
	});

	it("appends the settled entry when the trim already dropped the running one", () => {
		const activity: ChildActivity[] = [];
		applyCompactionActivity(activity, started());
		for (let i = 0; i < MAX_ACTIVITY_ITEMS + 5; i++) {
			activity.push({ kind: "tool", toolCallId: `t${i}`, name: "bash", label: "cmd", status: "success" });
		}
		trimActivity(activity);
		expect(activity.some((e) => e.kind === "compaction")).toBe(false);

		applyCompactionActivity(activity, ended(result("压缩摘要")));

		expect(activity[activity.length - 1]).toMatchObject({ kind: "compaction", status: "done" });
	});

	it("ignores unrelated session events", () => {
		const activity: ChildActivity[] = [];

		applyCompactionActivity(activity, { type: "agent_settled" });

		expect(activity).toEqual([]);
	});
});

describe("subagent activity trim", () => {
	it("drops the oldest entries down to the cap", () => {
		const activity: ChildActivity[] = [];
		for (let i = 0; i < MAX_ACTIVITY_ITEMS + 3; i++) {
			activity.push({ kind: "text", text: `第 ${i} 条` });
		}

		trimActivity(activity);

		expect(activity).toHaveLength(MAX_ACTIVITY_ITEMS);
		expect(activity[0]).toEqual({ kind: "text", text: "第 3 条" });
	});

	it("leaves a feed within the cap untouched", () => {
		const activity: ChildActivity[] = [{ kind: "text", text: "唯一一条" }];

		trimActivity(activity);

		expect(activity).toEqual([{ kind: "text", text: "唯一一条" }]);
	});
});
