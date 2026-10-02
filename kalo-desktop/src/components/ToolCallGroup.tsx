import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentActivityItem } from "../lib/subagent-activity";
import type { ToolCallRecord } from "../lib/timeline";
import { callTodos, groupTitle, rowLabel } from "../lib/tool-labels";
import { panelTabs } from "../lib/panel-tabs";
import { capToolOutput, contentText } from "../lib/tool-output";
import AgentActivityFeed from "./AgentActivityFeed";
import DiffView, { diffStats, extractDiff, resultText } from "./DiffView";
import { TodoStatusIcon } from "./TodoPanel";

/** Right-side chip label naming the concrete tool, e.g. "Read File". */
const TOOL_CHIPS: Record<string, string> = {
  read: "Read File",
  write: "Write File",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  ls: "LS",
  agent: "Sub Agent",
  todo_write: "Todo",
};

/**
 * Seconds a running bash may stay silent before its row unfolds on its own.
 * Long commands are exactly the ones whose row the user wants to watch; below
 * this threshold auto-expanding is noise (most commands finish in a second).
 */
const AUTO_OPEN_AFTER_SEC = 30;

/** Elapsed seconds while a call is running; null when unknown or settled. */
function runningSeconds(rec: ToolCallRecord, now: number): number | null {
  if (rec.status !== "running" || typeof rec.startedAt !== "number") return null;
  return Math.max(0, Math.floor((now - rec.startedAt) / 1000));
}

/** Open (or focus) the terminal mirror for one bash call, seeding its stream. */
function openBashInTerminal(rec: ToolCallRecord) {
  panelTabs.openWatchTab({
    toolCallId: rec.toolCallId,
    command: typeof rec.args?.command === "string" ? rec.args.command : "",
    status: rec.status,
    partialResult: rec.partialResult,
    result: rec.result,
  });
}

/**
 * Live step count for a subagent call: partial updates while running,
 * final turn count once settled.
 */
function agentSteps(rec: ToolCallRecord): number | null {
  const fromPartial = rec.partialResult?.details?.steps;
  if (typeof fromPartial === "number") return fromPartial;
  const fromResult = rec.result?.details?.turns;
  if (typeof fromResult === "number") return fromResult;
  return null;
}

function StatusMark({ rec }: { rec: ToolCallRecord }) {
  if (rec.status === "running") return <span className="spinner" />;
  if (rec.status === "error") return <span className="text-[var(--danger)]">✗</span>;
  return <span className="text-[var(--ok)]">✓</span>;
}

/**
 * The call rows without the group shell, for use inside a work segment.
 *
 * The segment header already summarizes the same calls as chips ("读取了 2 个
 * 文件"), and a segment is routinely cut into single-call groups by the
 * thinking blocks between them — so the per-group header there degenerates
 * into "读取了 1 个文件" stacked above the one row it describes. Dropping it
 * removes a nesting level and restores strict chronological order inside the
 * segment (doc/2026-09-13-工作段母气泡.md).
 */
export function ToolCallList({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <div className="flex flex-col text-[13px]">
      {calls.map((rec, i) => (
        <ToolCallRow key={rec.toolCallId} rec={rec} isLast={i === calls.length - 1} />
      ))}
    </div>
  );
}

export default function ToolCallGroup({ toolName, calls }: { toolName: string; calls: ToolCallRecord[] }) {
  // Groups start expanded so the user can follow what the agent is doing.
  const [open, setOpen] = useState(true);
  const anyRunning = calls.some((c) => c.status === "running");
  const anyError = calls.some((c) => c.status === "error");

  return (
    <div className="py-0.5 text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-card"
      >
        <span className="w-4 shrink-0 text-center">
          {anyRunning ? (
            <span className="spinner" />
          ) : anyError ? (
            <span className="text-[var(--danger)]">✗</span>
          ) : (
            <span className="text-[var(--ok)]">✓</span>
          )}
        </span>
        <span className="text-dim">{groupTitle(toolName, calls.length)}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`ml-auto shrink-0 text-dim transition-transform ${open ? "" : "-rotate-90"}`}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ml-6 flex flex-col border-l border-edge pl-2">
          {calls.map((rec, i) => (
            <ToolCallRow key={rec.toolCallId} rec={rec} isLast={i === calls.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ rec, isLast }: { rec: ToolCallRecord; isLast: boolean }) {
  // Call details start closed, except edits (inline diff) and the newest
  // todo_write. Consecutive todo_write calls collapse into one group, so
  // expanding every row would stack the same list over and over; only the
  // current plan is worth showing unfolded.
  //
  // Subagents stay collapsed even while running: their live activity feed is
  // long and re-expands on every session switch (rows remount), which buries
  // the surrounding conversation. Progress stays visible in the row itself via
  // the spinner and the "第 N 步" chip; click to open the feed on demand.
  const [open, setOpen] = useState(
    rec.toolName === "edit" || (rec.toolName === "todo_write" && isLast),
  );
  const diff = extractDiff(rec.result) ?? extractDiff(rec.partialResult);
  const stats = diff ? diffStats(diff) : null;
  const chip = TOOL_CHIPS[rec.toolName] ?? rec.toolName;
  const steps = rec.toolName === "agent" ? agentSteps(rec) : null;
  // Set once the user clicks the row: the 30s auto-expand must not fight a
  // deliberate collapse (doc/2026-10-02-桌面终端与长命令实时可见.md §2.3).
  const userToggled = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const elapsedSec = runningSeconds(rec, now);

  useEffect(() => {
    if (rec.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rec.status]);

  useEffect(() => {
    if (elapsedSec !== null && elapsedSec >= AUTO_OPEN_AFTER_SEC && !userToggled.current) setOpen(true);
  }, [elapsedSec]);

  return (
    <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-card">
      <button
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => !v);
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="w-4 shrink-0 text-center text-[11px]">
          <StatusMark rec={rec} />
        </span>
        <span className="mono min-w-0 flex-1 truncate text-xs text-dim group-hover:text-ink">
          {rowLabel(rec)}
        </span>
      </button>
      {stats && (
        <span className="mono shrink-0 text-xs">
          <span className="text-[var(--diff-add-text)]">+{stats.add}</span>{" "}
          <span className="text-[var(--diff-del-text)]">-{stats.del}</span>
        </span>
      )}
      {steps !== null && (
        <span
          className={`mono shrink-0 rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${
            rec.status === "running" ? "border-edge text-ink" : "border-edge text-dim"
          }`}
        >
          {rec.status === "running" ? `第 ${steps} 步` : `共 ${steps} 步`}
        </span>
      )}
      {elapsedSec !== null && elapsedSec >= 5 && (
        <span className="mono shrink-0 text-[10px] tabular-nums text-dim">已运行 {elapsedSec}s</span>
      )}
      <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-dim">
        {chip}
      </span>
      {rec.toolName === "bash" && (
        <button
          onClick={() => openBashInTerminal(rec)}
          title="在终端中打开"
          className="shrink-0 rounded p-1 text-dim hover:bg-card hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2.5 3.5l4 4-4 4M8.5 12.5h5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Tool output in a `<pre>`, capped to a head/tail window with an explicit way
 * out. Results are unbounded (build logs, file dumps) and every character
 * stays in the DOM for the life of the session, so the window is what keeps a
 * log-heavy session cheap to scroll (doc/2026-10-01-高负载下界面响应与输入可见性.md).
 *
 * `live` keeps a running command's newest line in view as output arrives.
 */
function OutputPre({
  text,
  maxHeight = "max-h-72",
  dim = false,
  live = false,
}: {
  text: string;
  maxHeight?: string;
  dim?: boolean;
  live?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const capped = useMemo(() => capToolOutput(text), [text]);
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!live) return;
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live, text]);
  return (
    <>
      <pre
        ref={preRef}
        className={`mono ${maxHeight} overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-card p-2 text-xs ${
          dim ? "text-dim" : ""
        }`}
      >
        {expanded ? text : capped.text}
      </pre>
      {capped.truncated && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1 self-start rounded border border-edge px-1.5 py-0.5 text-[10px] text-dim hover:bg-card"
        >
          显示全部（另有 {capped.hiddenChars.toLocaleString()} 字符 / {capped.hiddenLines.toLocaleString()} 行）
        </button>
      )}
    </>
  );
}

function ToolCallDetail({ rec, diff }: { rec: ToolCallRecord; diff?: string }) {
  if (rec.toolName === "agent") {
    const activity: AgentActivityItem[] | undefined =
      rec.result?.details?.activity ?? rec.partialResult?.details?.activity;
    if (activity?.length) {
      return (
        <div className="mb-1 ml-6 mt-1">
          <AgentActivityFeed activity={activity} />
        </div>
      );
    }
  }

  if (rec.toolName === "edit" && diff) {
    return (
      <div className="mb-1 ml-6 mt-1">
        <DiffView diff={diff} collapsible />
      </div>
    );
  }

  if (rec.toolName === "todo_write") {
    const todos = callTodos(rec);
    if (todos.length === 0) {
      return <div className="mb-1 ml-6 mt-1 text-xs text-dim">（空清单）</div>;
    }
    return (
      <div className="mb-1 ml-6 mt-1 flex flex-col gap-0.5 rounded-md border border-edge bg-card px-2.5 py-2">
        {todos.map((todo) => (
          <div key={todo.content} className="flex items-start gap-2 text-xs">
            <span className="mt-px shrink-0">
              <TodoStatusIcon status={todo.status} />
            </span>
            <span className={todo.status === "completed" ? "text-dim line-through" : "text-ink"}>{todo.content}</span>
          </div>
        ))}
      </div>
    );
  }

  if (rec.toolName === "bash") {
    // Settled result first (it carries the truncation footer); while running,
    // the partial's text blocks. No JSON fallback here: a fresh partial is
    // `{"content": []}`, and pretty-printed JSON reads as a debug leak.
    const output = resultText(rec.result) || contentText(rec.partialResult);
    return (
      <div className="mb-1 ml-6 mt-1 flex flex-col">
        {output ? (
          <OutputPre text={output} live={rec.status === "running"} />
        ) : (
          <div className="text-xs text-dim">{rec.status === "running" ? "运行中…（暂无输出）" : "（无输出）"}</div>
        )}
      </div>
    );
  }

  // Generic: args + result JSON
  const output = resultText(rec.result) || resultText(rec.partialResult);
  return (
    <div className="mb-1 ml-6 mt-1 flex flex-col gap-1">
      <OutputPre text={JSON.stringify(rec.args ?? {}, null, 2)} maxHeight="max-h-40" dim />
      {output && <OutputPre text={output} />}
    </div>
  );
}