import type { AssistantEntry, TimelineEntry } from "./timeline";
import { segmentStats, type SegmentStats } from "./work-segment";

export type ConversationRow =
  | { kind: "entry"; entry: TimelineEntry }
  | { kind: "segment"; id: string; entries: TimelineEntry[]; stats: SegmentStats; running: boolean; startedAt?: number };

function hasText(entry: AssistantEntry): boolean {
  return entry.message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

function isFailure(entry: AssistantEntry): boolean {
  return Boolean(entry.message.errorMessage) || entry.message.stopReason === "error" || entry.message.stopReason === "aborted";
}

/** Only recorded timestamps count; history pagination may supply zero/missing timestamps. */
export function processStartedAt(entries: TimelineEntry[]): number | undefined {
  let first: number | undefined;
  for (const entry of entries) {
    const times = entry.kind === "assistant" ? [entry.message.timestamp]
      : entry.kind === "toolGroup" ? entry.calls.map((call) => call.startedAt) : [];
    for (const time of times) {
      if (typeof time === "number" && Number.isFinite(time) && time > 0) first = Math.min(first ?? time, time);
    }
  }
  return first;
}

/** Group adjacent activity, keeping every prose message and deliverable in place. */
export function foldConversationTurns(timeline: TimelineEntry[], live: boolean): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let run: TimelineEntry[] = [];

  const flush = (active: boolean) => {
    let process: TimelineEntry[] = [];
    const flushProcess = (tail: boolean) => {
      if (process.length === 0) return;
      const stats = segmentStats(process);
      rows.push({ kind: "segment", id: process[0].id, entries: process, stats,
        running: active && (tail || stats.running), startedAt: processStartedAt(process) });
      process = [];
    };
    for (const entry of run) {
      if (entry.kind === "toolGroup") {
        if (entry.calls.length > 0) process.push(entry);
        continue;
      }
      if (entry.kind === "assistant" && !isFailure(entry) && !hasText(entry)) {
        // Tool-call placeholders must not add rows or change the group's identity.
        if (entry.message.content.some((block) => block.type === "thinking" && block.thinking.trim())) {
          process.push(entry.usage ? { ...entry, usage: undefined } : entry);
        }
        if (!entry.usage) continue;
        flushProcess(false);
        rows.push({ kind: "entry", entry: { ...entry, message: { ...entry.message,
          content: entry.message.content.filter((block) => block.type !== "thinking") } } });
        continue;
      }
      flushProcess(false);
      rows.push({ kind: "entry", entry });
    }
    flushProcess(true);
    run = [];
  };

  for (const entry of timeline) {
    if (entry.kind === "user" || entry.kind === "changes") {
      flush(false);
      rows.push({ kind: "entry", entry });
    } else {
      run.push(entry);
      // Usage fences autonomous runs without an intervening user or changes card.
      if (entry.kind === "assistant" && entry.usage) flush(false);
    }
  }
  flush(live);
  return rows;
}

export function formatProcessDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
