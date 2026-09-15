/**
 * Chat timeline view-model types.
 *
 * The chat transcript shown by the desktop is a `TimelineEntry[]`, a flat
 * render-ready stream (one entry per user bubble / assistant message / tool
 * group / retry notice / system notice / changed-files card / compaction
 * bubble). Entries are produced either live from engine events or rebuilt
 * from session-file history (see buildTimeline in chat-store).
 *
 * These types used to live in chat-store.ts; they were moved here so the
 * store (already over its line budget) could keep shrinking while the
 * timeline model grows.
 */
import type { AssistantMessage, UserMessage } from "../types";
import type { ChangeSummary } from "./changed-files";

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: any;
  status: "running" | "success" | "error";
  result?: any;
  partialResult?: any;
}

export interface UserEntry {
  id: string;
  kind: "user";
  message: UserMessage;
}

/** Aggregated token usage of one agent run (summed across all its LLM calls/turns). */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Number of LLM calls the totals were summed over. Shown in the footer so a
   * total far above the context window reads as "N full resends" instead of a
   * miscount.
   */
  calls: number;
}

export interface AssistantEntry {
  id: string;
  kind: "assistant";
  message: AssistantMessage;
  streaming: boolean;
  /** Set at agent_settled: aggregated usage of the whole run, shown once as a footer. */
  usage?: TurnUsage;
  /**
   * The message's error is covered by a retry notice (auto-retry started or
   * finally failed): the retry line carries the error, so no separate banner.
   */
  retriedError?: boolean;
}

export interface ToolGroupEntry {
  id: string;
  kind: "toolGroup";
  toolName: string;
  calls: ToolCallRecord[];
}

export interface RetryEntry {
  id: string;
  kind: "retry";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  done?: { success: boolean; finalError?: string };
}

export interface NoticeEntry {
  id: string;
  kind: "notice";
  text: string;
}

/**
 * A persistent bubble marking one context compaction in the transcript.
 *
 * Replaces the transient "正在压缩上下文…" notice when a compaction succeeds;
 * history replayed from the session file produces the same kind of entry.
 * Clicking the bubble toggles the summary text open (CompactionBubble).
 */
export interface CompactionEntry {
  id: string;
  kind: "compaction";
  /** The compaction summary the engine generated (markdown). */
  summary: string;
  /**
   * True when this compaction was triggered automatically (context
   * threshold/overflow). Only reliably known for live events — the session
   * file does not distinguish auto vs manual, so history entries are false.
   */
  auto: boolean;
  /** Context tokens before the compaction, when known. */
  tokensBefore?: number;
}

/**
 * End-of-run summary of the files the agent wrote or edited. Pushed once at
 * `agent_settled`, and only when at least one file changed.
 */
export interface ChangesEntry extends ChangeSummary {
  id: string;
  kind: "changes";
}

export type TimelineEntry =
  | UserEntry
  | AssistantEntry
  | ToolGroupEntry
  | RetryEntry
  | NoticeEntry
  | ChangesEntry
  | CompactionEntry;

/** One task of the agent's plan, written whole-list by the `todo_write` tool. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
