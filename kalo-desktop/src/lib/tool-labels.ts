/**
 * Human labels for tool calls (pure, no React).
 *
 * Lives in lib so both the tool group rows (ToolCallGroup) and the work-segment
 * header (work-segment.ts) name a call the same way.
 */
import type { TodoItem, ToolCallRecord } from "./timeline";

/** Verb used in the collapsed group header per tool name. */
export const TOOL_VERBS: Record<string, { verb: string; noun: string }> = {
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

export function groupTitle(toolName: string, count: number): string {
  const v = TOOL_VERBS[toolName];
  if (v) return `${v.verb}了 ${count} ${v.noun}`;
  return `${toolName} × ${count}`;
}

/** Verb + target label for a single call row, e.g. "读取 src/main.ts". */
export function rowLabel(rec: ToolCallRecord): string {
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
export function callTodos(rec: ToolCallRecord): TodoItem[] {
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
