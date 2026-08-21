import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { TodoItem, ToolCallRecord } from "../lib/chat-store";
import { CodeRenderer } from "./AssistantMessage";
import DiffView, { diffStats, extractDiff, resultText } from "./DiffView";
import { TodoStatusIcon } from "./TodoPanel";

/** Verb used in the collapsed group header per tool name. */
const TOOL_VERBS: Record<string, { verb: string; noun: string }> = {
  read: { verb: "读取", noun: "个文件" },
  write: { verb: "写入", noun: "个文件" },
  edit: { verb: "编辑", noun: "个文件" },
  bash: { verb: "执行", noun: "条命令" },
  grep: { verb: "搜索", noun: "次" },
  glob: { verb: "查找", noun: "次" },
  ls: { verb: "查看", noun: "个目录" },
  agent: { verb: "派生", noun: "个子 agent" },
  todo_write: { verb: "更新", noun: "次任务清单" },
};

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

function groupTitle(toolName: string, count: number): string {
  const v = TOOL_VERBS[toolName];
  if (v) return `${v.verb}了 ${count} ${v.noun}`;
  return `${toolName} × ${count}`;
}

/** Verb + target label for a single call row, e.g. "读取 src/main.ts". */
function rowLabel(rec: ToolCallRecord): string {
  const args = rec.args ?? {};
  const verb = TOOL_VERBS[rec.toolName]?.verb ?? rec.toolName;
  switch (rec.toolName) {
    case "read":
    case "write":
    case "edit":
      return `${verb} ${String(args.path ?? args.file_path ?? "(未知文件)")}`;
    case "bash":
      return String(args.command ?? "");
    case "grep":
      return `${verb} ${String(args.pattern ?? args.query ?? "")}`;
    case "glob":
      return `${verb} ${String(args.pattern ?? "")}`;
    case "ls":
      return `${verb} ${String(args.path ?? ".")}`;
    case "agent": {
      const desc = String(args.description ?? "").trim();
      if (desc) return desc;
      const prompt = String(args.prompt ?? "").trim().split("\n")[0];
      return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt || "子 agent 任务";
    }
    case "todo_write": {
      const todos = callTodos(rec);
      if (todos.length === 0) return "任务清单";
      const done = todos.filter((t) => t.status === "completed").length;
      const head = `${done}/${todos.length} 已完成`;
      const active = todos.find((t) => t.status === "in_progress");
      return active ? `${head} · ${active.content}` : head;
    }
    default:
      return rec.toolName;
  }
}

/**
 * The plan a todo_write call wrote. Prefers the result (canonical, trimmed by
 * the engine) and falls back to the args, so the row reads correctly while the
 * call is still running.
 */
function callTodos(rec: ToolCallRecord): TodoItem[] {
  const fromResult = rec.result?.details?.todos ?? rec.partialResult?.details?.todos;
  const raw = Array.isArray(fromResult) ? fromResult : rec.args?.todos;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t: any): t is TodoItem =>
      t &&
      typeof t.content === "string" &&
      (t.status === "pending" || t.status === "in_progress" || t.status === "completed"),
  );
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

/** One entry of a subagent's live activity feed (mirrors the harness type). */
type AgentActivityItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCallId: string; name: string; label: string; status: "running" | "success" | "error" };

function StatusMark({ rec }: { rec: ToolCallRecord }) {
  if (rec.status === "running") return <span className="spinner" />;
  if (rec.status === "error") return <span className="text-[var(--danger)]">✗</span>;
  return <span className="text-[var(--ok)]">✓</span>;
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
  // Call details start closed, except edits (inline diff), running subagents
  // (live activity feed), and the newest todo_write. Consecutive todo_write
  // calls collapse into one group, so expanding every row would stack the same
  // list over and over; only the current plan is worth showing unfolded.
  const [open, setOpen] = useState(
    rec.toolName === "edit" ||
      (rec.toolName === "agent" && rec.status === "running") ||
      (rec.toolName === "todo_write" && isLast),
  );
  const diff = extractDiff(rec.result) ?? extractDiff(rec.partialResult);
  const stats = diff ? diffStats(diff) : null;
  const chip = TOOL_CHIPS[rec.toolName] ?? rec.toolName;
  const steps = rec.toolName === "agent" ? agentSteps(rec) : null;

  return (
    <div className="rounded-md">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-card"
      >
        <span className="w-4 shrink-0 text-center text-[11px]">
          <StatusMark rec={rec} />
        </span>
        <span className="mono min-w-0 flex-1 truncate text-xs text-dim group-hover:text-ink">
          {rowLabel(rec)}
        </span>
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
        <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-dim">
          {chip}
        </span>
      </button>
      {open && <ToolCallDetail rec={rec} diff={diff} />}
    </div>
  );
}

function ToolCallDetail({ rec, diff }: { rec: ToolCallRecord; diff?: string }) {
  if (rec.toolName === "agent") {
    const activity: AgentActivityItem[] | undefined =
      rec.result?.details?.activity ?? rec.partialResult?.details?.activity;
    if (activity?.length) {
      return (
        <div className="mb-1 ml-6 mt-1 flex flex-col gap-1">
          {activity.map((item, i) =>
            item.kind === "tool" ? (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-3 shrink-0 text-center text-[11px]">
                  {item.status === "running" ? (
                    <span className="spinner" />
                  ) : item.status === "error" ? (
                    <span className="text-[var(--danger)]">✗</span>
                  ) : (
                    <span className="text-[var(--ok)]">✓</span>
                  )}
                </span>
                <span className="shrink-0 text-dim">{item.name}</span>
                <span className="mono min-w-0 flex-1 truncate text-dim">{item.label}</span>
              </div>
            ) : (
              <div
                key={i}
                className="markdown rounded-md border border-edge bg-card px-2.5 py-1.5 text-xs"
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={{
                    code: CodeRenderer as any,
                    pre: ({ children }) => <>{children}</>,
                  }}
                >
                  {item.text}
                </ReactMarkdown>
              </div>
            ),
          )}
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
    const output = resultText(rec.result) || resultText(rec.partialResult);
    return (
      <div className="mb-1 ml-6 mt-1">
        {output ? (
          <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-card p-2 text-xs">
            {output}
          </pre>
        ) : (
          <div className="text-xs text-dim">{rec.status === "running" ? "运行中…" : "（无输出）"}</div>
        )}
      </div>
    );
  }

  // Generic: args + result JSON
  const output = resultText(rec.result) || resultText(rec.partialResult);
  return (
    <div className="mb-1 ml-6 mt-1 flex flex-col gap-1">
      <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-card p-2 text-xs text-dim">
        {JSON.stringify(rec.args ?? {}, null, 2)}
      </pre>
      {output && (
        <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-card p-2 text-xs">
          {output}
        </pre>
      )}
    </div>
  );
}
