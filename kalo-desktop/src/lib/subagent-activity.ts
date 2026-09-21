/**
 * Subagent activity feed: the entry shape the engine pushes, plus the label
 * the card renders for a compaction entry.
 *
 * Mirrors the engine's `extensions/subagent/activity.ts` — the two must stay in
 * sync (contract: doc/2026-09-18-子agent压缩气泡.md). Text mapping lives here
 * rather than in the component because components are outside the desktop's
 * vitest boundary (kalo-desktop/AGENTS.md).
 */
import { formatK } from "./run-usage";

/** One compaction in a child's feed, as pushed by the engine. */
export interface CompactionActivityItem {
  kind: "compaction";
  reason: "manual" | "threshold" | "overflow";
  status: "running" | "done" | "failed";
  /** Context size before the compaction (successful ones). */
  tokensBefore?: number;
  /** Generated summary, capped by the engine at 2000 chars. */
  summary?: string;
  /** Set when the summary above was cut to fit the feed. */
  summaryTruncated?: boolean;
  /** True when the compaction was cancelled. */
  aborted?: boolean;
  /** Failure reason. */
  errorMessage?: string;
}

/** One entry of a subagent's live activity feed (mirrors the harness type). */
export type AgentActivityItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCallId: string; name: string; label: string; status: "running" | "success" | "error" }
  | CompactionActivityItem;

export interface CompactionActivityView {
  /** Pill text. */
  label: string;
  /** Right-side detail, e.g. the context size the compaction replaced. */
  meta?: string;
}

/**
 * Pill text for one compaction entry. An automatic compaction reads differently
 * from a manual one on purpose: the user triggered the manual case themselves
 * and only needs the outcome.
 */
export function compactionActivityView(item: CompactionActivityItem): CompactionActivityView {
  if (item.status === "running") return { label: "正在压缩上下文…" };
  if (item.status === "failed") {
    return {
      label: item.aborted ? "上下文压缩已取消" : `上下文压缩失败：${item.errorMessage ?? "未知原因"}`,
    };
  }
  return {
    label: item.reason === "manual" ? "上下文已压缩" : "上下文已自动压缩",
    ...(item.tokensBefore !== undefined ? { meta: `${formatK(item.tokensBefore)} tokens` } : {}),
  };
}