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

/** One process per run; only the settled final response and outputs stay outside. */
export function foldConversationTurns(timeline: TimelineEntry[], live: boolean): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let run: TimelineEntry[] = [];

  const flush = (active: boolean) => {
    const process: TimelineEntry[] = [];
    const outputs: TimelineEntry[] = [];
    // Only the last assistant can be the result. Never promote commentary
    // before a failed/aborted call or a tool-only ending into a final answer.
    const lastAssistant = run.filter((entry) => entry.kind === "assistant").at(-1);
    const final = !active && lastAssistant?.kind === "assistant" && hasText(lastAssistant)
      && !isFailure(lastAssistant) && lastAssistant.message.stopReason !== "toolUse"
      && !lastAssistant.message.content.some((block) => block.type === "toolCall")
      && !run.slice(run.indexOf(lastAssistant) + 1).some((entry) => entry.kind === "toolGroup")
      ? lastAssistant : undefined;
    for (const entry of run) {
      if (entry.kind === "artifacts" || entry.kind === "widget") {
        outputs.push(entry);
      } else if (entry.kind === "toolGroup") {
        const calls = entry.calls.filter((call) => call.toolName !== "present_files" || call.status === "error");
        if (calls.length > 0) process.push(calls.length === entry.calls.length ? entry : { ...entry, calls });
      } else if (entry.kind === "assistant") {
        if (entry === lastAssistant && isFailure(entry) && !entry.retriedError) {
          outputs.push(entry);
          continue;
        }
        const thinking = entry.message.content.filter((block) => block.type === "thinking");
        if (entry === final) {
          if (thinking.length) process.push({ ...entry, usage: undefined,
            message: { ...entry.message, content: thinking } });
          outputs.push(thinking.length ? { ...entry,
            message: { ...entry.message, content: entry.message.content.filter((block) => block.type !== "thinking") } } : entry);
        } else {
          if (hasText(entry) || thinking.length || isFailure(entry)) {
            process.push(entry.usage ? { ...entry, usage: undefined } : entry);
          }
          if (entry.usage) outputs.push({ ...entry, message: { ...entry.message, content: [] } });
        }
      } else {
        process.push(entry);
      }
    }
    if (process.length) rows.push({ kind: "segment", id: process[0].id, entries: process,
      stats: segmentStats(process), running: active, startedAt: processStartedAt(run) });
    rows.push(...outputs.map((entry): ConversationRow => ({ kind: "entry", entry })));
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
