import type { AssistantMessage } from "../types";
import type { TimelineEntry } from "./timeline";

export interface RetryStartEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface RetryEndEvent {
  success: boolean;
  finalError?: string;
}

/**
 * Fold an auto_retry_start into the timeline. The failed attempt's error
 * bubble is covered by the retry line (marked so AssistantMessage skips its
 * banner), and the open retry entry is updated in place across attempts
 * instead of stacking one banner per attempt.
 */
export function applyRetryStart(t: TimelineEntry[], ev: RetryStartEvent, id: string): void {
  markLastErrorRetried(t);
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.kind !== "retry") continue;
    if (e.done) break;
    t[i] = { ...e, attempt: ev.attempt, delayMs: ev.delayMs, errorMessage: ev.errorMessage };
    return;
  }
  t.push({
    id,
    kind: "retry",
    attempt: ev.attempt,
    maxAttempts: ev.maxAttempts,
    delayMs: ev.delayMs,
    errorMessage: ev.errorMessage,
  });
}

/** Fold an auto_retry_end: close the open retry entry. On final failure the retry line reports the error. */
export function applyRetryEnd(t: TimelineEntry[], ev: RetryEndEvent): void {
  if (!ev.success) markLastErrorRetried(t);
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.kind === "retry" && !e.done) {
      t[i] = { ...e, done: { success: ev.success, finalError: ev.finalError } };
      return;
    }
  }
}

/** Mark the latest failed assistant entry as covered by a retry notice. */
function markLastErrorRetried(t: TimelineEntry[]): void {
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.kind !== "assistant") continue;
    if (e.message.stopReason === "error" && !e.retriedError) {
      t[i] = { ...e, retriedError: true };
    }
    return;
  }
}

/**
 * The session file persists every failed retry attempt as its own assistant
 * message, so a reloaded session would show one error bubble per attempt.
 * Push an assistant message rebuilt from history, folding a run of identical
 * contentless error messages into the latest one — by then the retries are
 * history and a single bubble carries the error.
 */
export function pushAssistantEntry(t: TimelineEntry[], m: AssistantMessage, id: string): void {
  const visible = m.content.some(
    (c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
  );
  const last = t[t.length - 1];
  if (
    m.stopReason === "error" &&
    !visible &&
    last?.kind === "assistant" &&
    last.message.stopReason === "error" &&
    last.message.errorMessage === m.errorMessage
  ) {
    t[t.length - 1] = { id, kind: "assistant", message: m, streaming: false };
    return;
  }
  t.push({ id, kind: "assistant", message: m, streaming: false });
}
