/**
 * Compaction notice → persistent bubble placement (pure timeline logic).
 *
 * The engine reports compaction lifecycle over `compaction_start` /
 * `compaction_end` events. The desktop keeps the *transient* "正在压缩上下文…"
 * notice while the compaction runs, then settles it once:
 *
 *  - succeeded with a summary → the notice is replaced *in place* by a
 *    persistent CompactionEntry bubble (doc/2026-09-09-自动压缩气泡常驻与摘要展开.md);
 *  - cancelled / failed / succeeded without a summary → the notice keeps its
 *    transient shape and only its text is updated.
 *
 * Pure and UI-free so it stays unit-testable (chat-store event dispatch only).
 */
import type { CompactionEntry, NoticeEntry, TimelineEntry } from "./timeline";

/** The compaction_end event fields the settlement logic needs. */
export interface CompactionEnd {
  aborted: boolean;
  errorMessage?: string;
  reason?: "manual" | "threshold" | "overflow";
  result?: { summary?: string; tokensBefore?: number };
}

export const COMPACTING_TEXT = "正在压缩上下文…";

/** Compaction started: append the transient notice the bubble will replace. */
export function pushCompactingNotice(timeline: TimelineEntry[], id: string): void {
  timeline.push({ id, kind: "notice", text: COMPACTING_TEXT });
}

/**
 * Settle a finished compaction. Replaces the running notice with a persistent
 * bubble when a summary is available, otherwise updates the notice text.
 * When the notice is gone (timeline rebuilt in between) the result is simply
 * appended at the tail.
 */
export function settleCompaction(
  timeline: TimelineEntry[],
  noticeId: string | null,
  end: CompactionEnd,
  nextId: () => string,
): void {
  const idx = noticeId ? timeline.findIndex((e) => e.id === noticeId) : -1;
  const settledId = idx >= 0 && noticeId ? noticeId : nextId();
  const upsert = (entry: TimelineEntry) => {
    if (idx >= 0) timeline[idx] = entry;
    else timeline.push(entry);
  };

  const failed = end.aborted || Boolean(end.errorMessage);
  const summary = failed ? undefined : end.result?.summary;
  if (summary) {
    const bubble: CompactionEntry = {
      id: settledId,
      kind: "compaction",
      summary,
      auto: end.reason !== "manual",
      ...(end.result?.tokensBefore !== undefined ? { tokensBefore: end.result.tokensBefore } : {}),
    };
    upsert(bubble);
    return;
  }
  const text = end.aborted
    ? "上下文压缩已取消"
    : end.errorMessage
      ? `上下文压缩失败：${end.errorMessage}`
      : "上下文已压缩";
  upsert({ id: settledId, kind: "notice", text } satisfies NoticeEntry);
}
