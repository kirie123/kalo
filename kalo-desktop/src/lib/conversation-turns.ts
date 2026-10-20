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

/** View-only grouping. A whole run includes progress prose, not only adjacent tool calls. */
export function foldConversationTurns(timeline: TimelineEntry[], live: boolean): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let run: TimelineEntry[] = [];

  const flush = (running: boolean) => {
    if (run.length === 0) return;
    let lastTool = -1;
    let final = -1;
    run.forEach((entry, index) => { if (entry.kind === "toolGroup") lastTool = index; });
    if (!running) {
      for (let i = run.length - 1; i > lastTool; i--) {
        const entry = run[i];
        if (entry.kind === "assistant" && isFailure(entry)) break;
        if (entry.kind === "assistant" && hasText(entry) && entry.message.stopReason !== "toolUse"
          && !entry.message.content.some((block) => block.type === "toolCall")) {
          final = i;
          break;
        }
      }
    }

    const process: TimelineEntry[] = [];
    const output: TimelineEntry[] = [];
    run.forEach((entry, index) => {
      if (index === final && entry.kind === "assistant") {
        const thinking = entry.message.content.filter((block) => block.type === "thinking" && block.thinking.trim());
        if (thinking.length > 0) {
          process.push({ ...entry, id: `${entry.id}:thinking`, usage: undefined, message: { ...entry.message, content: thinking } });
          output.push({ ...entry, message: { ...entry.message, content: entry.message.content.filter((block) => block.type !== "thinking") } });
        } else output.push(entry);
      } else if ((entry.kind === "assistant" && !isFailure(entry))
        || entry.kind === "toolGroup" || entry.kind === "retry" || entry.kind === "compaction") {
        process.push(entry);
      } else output.push(entry);
    });
    if (process.length > 0) {
      rows.push({ kind: "segment", id: run[0].id, entries: process, stats: segmentStats(process), running, startedAt: processStartedAt(run) });
    }
    rows.push(...output.map((entry): ConversationRow => ({ kind: "entry", entry })));
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
