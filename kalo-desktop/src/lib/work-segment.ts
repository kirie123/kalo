/**
 * Work segments: fold a run of consecutive "process" timeline entries
 * (thinking-only assistant messages + tool groups + retry notices) into one
 * collapsible parent bubble.
 *
 * A complex turn produces 20–60 process entries; each one already folds on its
 * own, but folding 30 times is as tiring as not folding at all. Grouping them
 * under one header lets a finished turn occupy two lines (question + segment
 * header) so the transcript stays scannable (doc/2026-09-13-工作段母气泡.md).
 *
 * This is a pure render-layer view over the timeline: entries are neither
 * rewritten nor reordered, so live streaming and history replayed from session
 * files produce exactly the same rows.
 */
import type { AssistantMessage } from "../types";
import type { AssistantEntry, TimelineEntry, ToolGroupEntry } from "./timeline";
import { rowLabel } from "./tool-labels";

/** Runs shorter than this stay as plain rows: one lone Thought needs no shell. */
const MIN_SEGMENT_ENTRIES = 2;

export interface SegmentStats {
  /** Thinking blocks + tool calls in the segment. */
  steps: number;
  thoughts: number;
  /** Per-tool call counts, in first-appearance order. */
  tools: { name: string; count: number }[];
  running: boolean;
  error: boolean;
  /** What the last step was (or is), for the collapsed one-line preview. */
  lastLabel: string;
}

export type RenderRow =
  | { kind: "entry"; entry: TimelineEntry }
  | { kind: "segment"; id: string; entries: TimelineEntry[]; stats: SegmentStats };

/**
 * True when an entry is agent *process* rather than agent *output*.
 *
 * Anything the user reads as a result — prose, errors, interruptions, the
 * changed-files card, compaction bubbles — stays outside and cuts the segment,
 * so folding never hides a conclusion.
 */
export function isProcessEntry(entry: TimelineEntry): boolean {
  switch (entry.kind) {
    case "toolGroup":
    case "retry":
      return true;
    case "assistant":
      return isProcessAssistant(entry.message);
    default:
      return false;
  }
}

/**
 * Assistant messages that render no prose: thinking-only, tool-call-only, or
 * still empty while streaming. Errors and interrupts are output — their banner
 * / divider must stay visible.
 */
function isProcessAssistant(message: AssistantMessage): boolean {
  if (message.errorMessage) return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  return !message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

/** Group consecutive process entries; everything else passes through as-is. */
export function foldWorkSegments(timeline: TimelineEntry[]): RenderRow[] {
  const rows: RenderRow[] = [];
  let run: TimelineEntry[] = [];

  const flush = () => {
    if (run.length >= MIN_SEGMENT_ENTRIES) {
      rows.push({ kind: "segment", id: run[0].id, entries: run, stats: segmentStats(run) });
    } else {
      for (const entry of run) rows.push({ kind: "entry", entry });
    }
    run = [];
  };

  for (const entry of timeline) {
    if (isProcessEntry(entry)) {
      run.push(entry);
      continue;
    }
    flush();
    rows.push({ kind: "entry", entry });
  }
  flush();
  return rows;
}

export function segmentStats(entries: TimelineEntry[]): SegmentStats {
  let thoughts = 0;
  let calls = 0;
  let running = false;
  let error = false;
  const tools: { name: string; count: number }[] = [];
  const toolIndex = new Map<string, number>();
  let lastLabel = "";

  for (const entry of entries) {
    if (entry.kind === "assistant") {
      const blocks = (entry as AssistantEntry).message.content.filter((b) => b.type === "thinking");
      thoughts += blocks.length;
      if (blocks.length > 0) lastLabel = "思考";
      continue;
    }
    if (entry.kind === "retry") {
      error = error || entry.done?.success === false;
      lastLabel = "重试请求";
      continue;
    }
    if (entry.kind !== "toolGroup") continue;
    const group = entry as ToolGroupEntry;
    calls += group.calls.length;
    const at = toolIndex.get(group.toolName);
    if (at === undefined) {
      toolIndex.set(group.toolName, tools.length);
      tools.push({ name: group.toolName, count: group.calls.length });
    } else {
      tools[at].count += group.calls.length;
    }
    for (const call of group.calls) {
      if (call.status === "running") running = true;
      if (call.status === "error") error = true;
    }
    const last = group.calls[group.calls.length - 1];
    if (last) lastLabel = rowLabel(last);
  }

  return { steps: thoughts + calls, thoughts, tools, running, error, lastLabel };
}

/**
 * Segment rows are rebuilt on every streaming flush, so identity comparison
 * would re-render every segment ~20×/s. The store clones only the entries it
 * mutated, so comparing entry references element-wise is enough.
 */
export function sameSegmentEntries(a: TimelineEntry[], b: TimelineEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry === b[i]);
}
