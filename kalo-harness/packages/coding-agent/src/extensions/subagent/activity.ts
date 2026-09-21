/**
 * A child's live activity feed: the entries and the compaction fold.
 *
 * Kept apart from index.ts so the feed stays testable without booting a whole
 * extension: the desktop card renders exactly this shape, and the engine↔desktop
 * contract only exists while it stays in sync (doc/2026-09-18-子agent压缩气泡.md).
 */

import type { AgentSessionEvent } from "../../core/agent-session.ts";

/** Per-entry cap for feed texts pushed to the UI. */
export const MAX_ACTIVITY_TEXT_CHARS = 2_000;
/** Total entries kept in the feed. */
export const MAX_ACTIVITY_ITEMS = 200;

/** One compaction in the child's feed, mirroring the main session's bubble vocabulary. */
export interface CompactionActivity {
	kind: "compaction";
	/** Trigger, same values the main session's compaction events use. */
	reason: "manual" | "threshold" | "overflow";
	status: "running" | "done" | "failed";
	/** Context size before the compaction (successful ones). */
	tokensBefore?: number;
	/** Generated summary, capped at MAX_ACTIVITY_TEXT_CHARS. */
	summary?: string;
	/** Set when the summary above was cut to fit the feed. */
	summaryTruncated?: boolean;
	/** True when the compaction was cancelled. */
	aborted?: boolean;
	/** Failure reason. */
	errorMessage?: string;
}

/** One entry in the child's live activity feed (assistant texts, tool calls, compactions). */
export type ChildActivity =
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			toolCallId: string;
			name: string;
			label: string;
			status: "running" | "success" | "error";
	  }
	| CompactionActivity;

/** Drop the oldest entries once the feed outgrows the cap. */
export function trimActivity(activity: ChildActivity[]): void {
	if (activity.length > MAX_ACTIVITY_ITEMS) {
		activity.splice(0, activity.length - MAX_ACTIVITY_ITEMS);
	}
}

/**
 * Fold a child's compaction lifecycle into its activity feed.
 *
 * A child runs the same auto-compaction as any session (see
 * doc/2026-01-01-每轮LLM调用前检查压缩.md), but has no UI of its own: without an
 * entry the card shows one unbroken feed and the context swap is invisible.
 * `compaction_end` updates the running entry in place; when the feed's trim
 * already dropped it, the settled entry is appended rather than lost.
 */
export function applyCompactionActivity(activity: ChildActivity[], event: AgentSessionEvent): void {
	if (event.type === "compaction_start") {
		activity.push({ kind: "compaction", reason: event.reason, status: "running" });
		return;
	}

	if (event.type !== "compaction_end") return;

	const runningIndex = findLastRunningCompaction(activity);
	const settled: ChildActivity = event.result
		? {
				kind: "compaction",
				reason: event.reason,
				status: "done",
				tokensBefore: event.result.tokensBefore,
				...truncateSummary(event.result.summary),
			}
		: event.aborted
			? { kind: "compaction", reason: event.reason, status: "failed", aborted: true }
			: {
					kind: "compaction",
					reason: event.reason,
					status: "failed",
					errorMessage: event.errorMessage ?? "压缩失败（未提供原因）",
				};
	if (runningIndex >= 0) activity[runningIndex] = settled;
	else activity.push(settled);
}

/** Last still-running compaction entry, or -1 once the feed's trim dropped it. */
function findLastRunningCompaction(activity: ChildActivity[]): number {
	for (let i = activity.length - 1; i >= 0; i--) {
		const entry = activity[i];
		if (entry.kind === "compaction" && entry.status === "running") return i;
	}
	return -1;
}

/** Summary into the feed, capped like every other activity text. */
function truncateSummary(summary: string): Pick<CompactionActivity, "summary" | "summaryTruncated"> {
	if (summary.length <= MAX_ACTIVITY_TEXT_CHARS) return { summary };
	return { summary: `${summary.slice(0, MAX_ACTIVITY_TEXT_CHARS)}…`, summaryTruncated: true };
}
