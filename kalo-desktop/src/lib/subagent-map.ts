/**
 * Subagent map: derive "the child agents of this session" from the chat
 * timeline.
 *
 * Design: doc/2026-09-30-子agent活动面板.md. Everything a node needs is already
 * inside the `agent` tool call record — args (description/prompt/tools/resume),
 * the live `partialResult.details` while the child runs, and the settled
 * `result.details` (childId/turns/tokens/activity/transcriptPath/ending). So
 * the map needs no new engine event and no RPC: a live run and a session
 * replayed from its file produce the same nodes.
 *
 * This module is the pure half (kalo-desktop/AGENTS.md): the button and the
 * modal only draw what these functions return.
 */
import type { AgentActivityItem } from "./subagent-activity";
import { rowLabel } from "./tool-labels";
import type { TimelineEntry, ToolCallRecord } from "./timeline";

export type SubagentStatus = "running" | "done" | "failed" | "stalled" | "aborted";

/** One child agent of the current session, folded across its resume calls. */
export interface SubagentNode {
  /**
   * Stable identity: the engine's childId once a result landed, else the
   * resume target, else the tool call id of a still-running fresh child.
   */
  key: string;
  /** Engine child id (`subagent-N`); undefined while a fresh child runs. */
  id?: string;
  /** Task summary (`description`, else the prompt's first line). */
  title: string;
  /** Full prompt of the most recent call (empty when the model sent none). */
  prompt: string;
  /** Tool set the child was created with. */
  tools?: string[];
  status: SubagentStatus;
  /** Latest step count: partial `steps` while running, settled `turns` after. */
  steps?: number;
  /** Child's cumulative token count (engine sums its whole history). */
  tokens?: number;
  /** How many `agent` calls target this child; 1 = never resumed. */
  calls: number;
  /** Live activity feed of the most recent call. */
  activity?: AgentActivityItem[];
  /** Failure text of the most recent call, when it ended with one. */
  errorMessage?: string;
  /** Markdown transcript of the child's runs, when one was written. */
  transcriptPath?: string;
  /** Tool call id of the most recent call. */
  toolCallId: string;
}

export interface SubagentCount {
  total: number;
  running: number;
}

/** The `agent` tool call records of a timeline, oldest first. */
function* agentCalls(timeline: TimelineEntry[]): Generator<ToolCallRecord> {
  for (const entry of timeline) {
    if (entry.kind !== "toolGroup") continue;
    // Filter by the call's own tool name (not the group's) so a future change
    // to how calls are grouped cannot silently empty the map.
    for (const rec of entry.calls) {
      if (rec.toolName === "agent") yield rec;
    }
  }
}

/** Details of the most recent push: the settled result wins over the partial. */
function detailsOf(rec: ToolCallRecord): Record<string, any> | undefined {
  return rec.result?.details ?? rec.partialResult?.details;
}

/**
 * Node identity for one call.
 *
 * Engine child ids (`subagent-N`) are per-process counters (`children.ts`
 * `nextChildId`), so a session that outlives an engine restart sees the same id
 * twice for two *different* children — real files have `subagent-1` three
 * times with `resumed: false`. Identity therefore follows the call's own
 * statement, never the id alone:
 *
 * - a fresh call always opens a node (the second `subagent-1` of a session is
 *   keyed `subagent-1#2`);
 * - a call that says it is a resume (`args.resume`, or `details.resumed`) joins
 *   the newest node carrying that id, which mirrors the engine's own
 *   "newest session file wins" revive rule;
 * - a running *fresh* child has no id yet, so its call id stands in — nobody can
 *   resume it before the result hands the id out.
 */
function assignKey(
  rec: ToolCallRecord,
  details: Record<string, any> | undefined,
  latestKeyByChildId: Map<string, string>,
  freshCounts: Map<string, number>,
): string {
  const childId = stringField(details?.childId);
  const resumeTarget = stringField(rec.args?.resume);
  const resumed = Boolean(resumeTarget) || details?.resumed === true;

  if (childId) {
    let key: string;
    if (resumed) {
      key = latestKeyByChildId.get(childId) ?? childId;
    } else {
      const seen = (freshCounts.get(childId) ?? 0) + 1;
      freshCounts.set(childId, seen);
      key = seen === 1 ? childId : `${childId}#${seen}`;
    }
    latestKeyByChildId.set(childId, key);
    return key;
  }
  if (resumeTarget) return latestKeyByChildId.get(resumeTarget) ?? resumeTarget;
  return rec.toolCallId;
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function statusOf(rec: ToolCallRecord, details: Record<string, any> | undefined): SubagentStatus {
  // A running record is authoritative: a child's turn may already carry the
  // watchdog/abort flags of the *previous* turn on an older record.
  if (rec.status === "running") return "running";
  if (details?.failed) return "failed";
  if (details?.stalled) return "stalled";
  if (details?.aborted) return "aborted";
  // Errored with no details: the parent run was cut off before the child
  // answered (aborted round), or the engine refused the call outright.
  if (rec.status === "error") return "failed";
  return "done";
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * All child agents of the session, in the order they were first spawned.
 *
 * Later calls on the same child overwrite the earlier ones (tokens and steps
 * are cumulative on the engine's side, so the newest value is the total) and
 * bump `calls`, which is what makes a resumed child read as one node.
 */
export function collectSubagents(timeline: TimelineEntry[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>();
  const latestKeyByChildId = new Map<string, string>();
  const freshCounts = new Map<string, number>();
  for (const rec of agentCalls(timeline)) {
    const details = detailsOf(rec);
    const key = assignKey(rec, details, latestKeyByChildId, freshCounts);
    const previous = nodes.get(key);
    const childId = stringField(details?.childId);
    const tools = Array.isArray(rec.args?.tools) && rec.args.tools.length > 0 ? (rec.args.tools as string[]) : undefined;
    nodes.set(key, {
      key,
      id: childId ?? previous?.id,
      title: rowLabel(rec),
      prompt: typeof rec.args?.prompt === "string" ? rec.args.prompt : "",
      tools: tools ?? previous?.tools,
      status: statusOf(rec, details),
      // A call that has not pushed anything yet (engine restart, resume still
      // starting) keeps the previous turn's numbers instead of blanking out.
      steps: numberOrUndefined(details?.steps) ?? numberOrUndefined(details?.turns) ?? previous?.steps,
      tokens: numberOrUndefined(details?.tokens) ?? previous?.tokens,
      calls: (previous?.calls ?? 0) + 1,
      activity: Array.isArray(details?.activity)
        ? (details.activity as AgentActivityItem[])
        : previous?.activity,
      errorMessage: typeof details?.failed === "string" ? details.failed : undefined,
      transcriptPath:
        typeof details?.transcriptPath === "string" ? details.transcriptPath : previous?.transcriptPath,
      toolCallId: rec.toolCallId,
    });
  }
  return [...nodes.values()];
}

/** Total and running counts, for the composer button. */
export function summarizeSubagents(nodes: SubagentNode[]): SubagentCount {
  let running = 0;
  for (const node of nodes) {
    if (node.status === "running") running++;
  }
  return { total: nodes.length, running };
}

/**
 * Shallow equality for `useChatSelector`: the timeline churns at ~20fps while
 * streaming, and the modal must not re-render for commits that did not move an
 * agent. The activity feed is compared by reference on purpose — the engine
 * pushes a fresh array on every child step, so an unchanged reference means an
 * unchanged feed.
 */
export function sameSubagentNodes(a: SubagentNode[], b: SubagentNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.key !== y.key ||
      x.id !== y.id ||
      x.status !== y.status ||
      x.steps !== y.steps ||
      x.tokens !== y.tokens ||
      x.calls !== y.calls ||
      x.title !== y.title ||
      x.prompt !== y.prompt ||
      x.errorMessage !== y.errorMessage ||
      x.transcriptPath !== y.transcriptPath ||
      x.toolCallId !== y.toolCallId ||
      x.activity !== y.activity ||
      !sameTools(x.tools, y.tools)
    ) {
      return false;
    }
  }
  return true;
}

function sameTools(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export interface SubagentStatusView {
  label: string;
  tone: "running" | "ok" | "warn" | "danger";
}

/** Status pill text and tone for one node (components only draw this). */
export function agentStatusView(node: SubagentNode): SubagentStatusView {
  switch (node.status) {
    case "running":
      return { label: "运行中", tone: "running" };
    case "done":
      return { label: "已完成", tone: "ok" };
    case "stalled":
      return { label: "卡死中止", tone: "warn" };
    case "aborted":
      return { label: "已中止", tone: "warn" };
    case "failed":
      return { label: node.errorMessage ? `失败：${truncate(node.errorMessage, 60)}` : "失败", tone: "danger" };
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * One-line "what is it doing right now" summary for a node's card, taken from
 * the tail of its activity feed. Undefined when the child never emitted one.
 */
export function agentActivitySummary(node: SubagentNode): string | undefined {
  const last = node.activity?.[node.activity.length - 1];
  if (!last) return undefined;
  if (last.kind === "tool") return `${last.name} ${truncate(last.label, 60)}`.trim();
  if (last.kind === "compaction") return "正在压缩上下文…";
  return truncate(last.text, 60);
}