import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentActivityItem } from "../lib/subagent-activity";
import type { ToolCallRecord } from "../lib/timeline";
import { callTodos, groupTitle, rowLabel } from "../lib/tool-labels";
import { panelTabs } from "../lib/panel-tabs";
import { capToolOutput, contentText } from "../lib/tool-output";
import AgentActivityFeed from "./AgentActivityFeed";
import DiffView, { diffStats, extractDiff, resultText } from "./DiffView";
import { TodoStatusIcon } from "./TodoPanel";

/** Muted outline icons identify actions without adding tool-name badges. */
function ToolIcon({ name }: { name: string }) {
  const path = name === "bash" ? "M3 4l4 4-4 4M9 12h4"
    : name === "edit" || name === "write" ? "M10 2l4 4-8 8H2v-4zM8 4l4 4"
      : name === "read" || name === "ls" ? "M3 2h7l3 3v9H3zM9 2v4h4M5 9h5M5 11h4"
        : name === "web_fetch" ? "M2 8h12M8 1a7 7 0 100 14A7 7 0 008 1M8 1c-4 4-4 10 0 14M8 1c4 4 4 10 0 14"
          : "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z";
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d={path} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

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
  return <ToolIcon name={rec.toolName} />;
}

/** Each visible call row is the only disclosure control for its result. */
export function ToolCallList({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <div className="flex flex-col text-[13px]">
      {calls.map((rec) => <ToolCallRow key={rec.toolCallId} rec={rec} />)}
    </div>
  );
}

export default function ToolCallGroup({ toolName, calls, compact = false }: { toolName: string; calls: ToolCallRecord[]; compact?: boolean }) {
  return (
    <div className={`tool-activity ${compact ? "is-compact" : ""}`}>
      {calls.length > 1 && <div className="py-1 text-xs text-dim">{groupTitle(toolName, calls.length)}</div>}
      <ToolCallList calls={calls} />
    </div>
  );
}

function ToolCallRow({ rec }: { rec: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const diff = extractDiff(rec.result) ?? extractDiff(rec.partialResult);
  const stats = diff ? diffStats(diff) : null;
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
    <>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-card">
        <button
          aria-expanded={open}
          aria-controls={contentId}
          title={rowLabel(rec)}
          onClick={() => {
            userToggled.current = true;
            setOpen((v) => !v);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="grid w-4 shrink-0 place-items-center text-[11px] text-dim">
            <StatusMark rec={rec} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-dim group-hover:text-ink">
            {rowLabel(rec)}
          </span>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className={`shrink-0 text-dim ${open ? "rotate-90" : ""}`}><path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
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
      {/* Below the row, not inside it: the row is the flex/hover line, and a
          multi-line detail inside it would be stretched into a column. */}
      {open && <div id={contentId}><ToolCallDetail rec={rec} diff={diff} /></div>}
    </>
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
