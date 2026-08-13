import { useState } from "react";
import type { ToolCallRecord } from "../lib/chat-store";
import DiffView, { diffStats, extractDiff, resultText } from "./DiffView";

/** Verb used in the collapsed group header per tool name. */
const TOOL_VERBS: Record<string, { verb: string; noun: string }> = {
  read: { verb: "读取", noun: "个文件" },
  write: { verb: "写入", noun: "个文件" },
  edit: { verb: "编辑", noun: "个文件" },
  bash: { verb: "执行", noun: "条命令" },
  grep: { verb: "搜索", noun: "次" },
  glob: { verb: "查找", noun: "次" },
  ls: { verb: "查看", noun: "个目录" },
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
    default:
      return rec.toolName;
  }
}

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
          {calls.map((rec) => (
            <ToolCallRow key={rec.toolCallId} rec={rec} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ rec }: { rec: ToolCallRecord }) {
  // Call details start closed, except edits which show their diff inline.
  const [open, setOpen] = useState(rec.toolName === "edit");
  const diff = extractDiff(rec.result) ?? extractDiff(rec.partialResult);
  const stats = diff ? diffStats(diff) : null;
  const chip = TOOL_CHIPS[rec.toolName] ?? rec.toolName;

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
        <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-dim">
          {chip}
        </span>
      </button>
      {open && <ToolCallDetail rec={rec} diff={diff} />}
    </div>
  );
}

function ToolCallDetail({ rec, diff }: { rec: ToolCallRecord; diff?: string }) {
  if (rec.toolName === "edit" && diff) {
    return (
      <div className="mb-1 ml-6 mt-1">
        <DiffView diff={diff} />
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
