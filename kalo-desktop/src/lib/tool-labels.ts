/**
 * Human labels for tool calls (pure, no React).
 *
 * Lives in lib so both the tool group rows (ToolCallGroup) and the work-segment
 * header (work-segment.ts) name a call the same way.
 *
 * Two rules keep engine internals out of the transcript: every built-in tool
 * gets a human verb/noun, and anything unmapped (MCP servers, an engine tool
 * added later) collapses into one generic phrase instead of its raw id — a
 * header chip reading "job_list × 1" is noise, not information
 * (doc/2026-09-13-工作段母气泡.md §3.2).
 */
import type { TodoItem, ToolCallRecord } from "./timeline";

/** Verb + noun per tool, rendered as "读取了 3 个文件" / "执行了 2 条命令". */
export const TOOL_VERBS: Record<string, { verb: string; noun: string }> = {
  // core tools
  read: { verb: "读取", noun: "个文件" },
  write: { verb: "写入", noun: "个文件" },
  edit: { verb: "编辑", noun: "个文件" },
  bash: { verb: "执行", noun: "条命令" },
  grep: { verb: "搜索", noun: "次" },
  glob: { verb: "查找", noun: "次" },
  find: { verb: "查找", noun: "次" },
  ls: { verb: "查看", noun: "个目录" },
  // kalo built-ins
  agent: { verb: "派生", noun: "个子 agent" },
  todo_write: { verb: "更新", noun: "次任务清单" },
  ask_user: { verb: "提问", noun: "次" },
  use_skill: { verb: "加载", noun: "个技能" },
  read_me: { verb: "加载", noun: "次可视化规范" },
  web_fetch: { verb: "抓取", noun: "个网页" },
  memory_save: { verb: "记录", noun: "条记忆" },
  memory_search: { verb: "检索", noun: "次记忆" },
  memory_list: { verb: "查看", noun: "次记忆" },
  job_list: { verb: "查看", noun: "次后台任务" },
  job_output: { verb: "读取", noun: "次任务输出" },
  job_kill: { verb: "停止", noun: "个后台任务" },
  present_files: { verb: "呈现", noun: "次产物" },
  show_widget: { verb: "渲染", noun: "个可视化" },
};

/** Fallback for unmapped tools: the raw id says nothing to a reader. */
const OTHER_TOOL = { verb: "调用", noun: "次其他工具" };

function toolVerbs(toolName: string): { verb: string; noun: string } {
  return TOOL_VERBS[toolName] ?? OTHER_TOOL;
}

export interface ToolChip {
  /** Label identity: tools sharing a label share a chip. */
  key: string;
  /** e.g. "读取了 3 个文件". */
  label: string;
  count: number;
}

/**
 * Chip row for a work segment.
 *
 * Tools that read the same merge into one chip (glob + find are both "查找了 N
 * 次") and unmapped tools merge into a single generic chip, so the header stays
 * a summary of what happened rather than a list of ids.
 */
export function toolChips(tools: { name: string; count: number }[]): ToolChip[] {
  const groups = new Map<string, { verb: string; noun: string; count: number }>();
  for (const tool of tools) {
    const { verb, noun } = toolVerbs(tool.name);
    const key = `${verb}|${noun}`;
    const found = groups.get(key);
    if (found) found.count += tool.count;
    else groups.set(key, { verb, noun, count: tool.count });
  }
  return [...groups].map(([key, { verb, noun, count }]) => ({
    key,
    count,
    label: `${verb}了 ${count} ${noun}`,
  }));
}

/** Collapsed group header / segment chip text for one tool. */
export function groupTitle(toolName: string, count: number): string {
  return toolChips([{ name: toolName, count }])[0].label;
}

/** Verb + target label for a single call row, e.g. "读取 src/main.ts". */
export function rowLabel(rec: ToolCallRecord): string {
  const args = rec.args ?? {};
  const verb = toolVerbs(rec.toolName).verb;
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
    case "find":
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
    case "web_fetch":
      return `${verb} ${String(args.url ?? "")}`;
    case "use_skill":
      return `${verb} ${String(args.name ?? "技能")}`;
    case "memory_save":
      return `${verb} ${String(args.title ?? "记忆")}`;
    case "memory_search":
      return `${verb} ${String(args.query ?? "记忆")}`;
    case "memory_list":
      return args.tag ? `查看记忆（${String(args.tag)}）` : "查看记忆";
    case "ask_user":
      return "向你提问";
    case "job_list":
      return "查看后台任务";
    case "job_output":
      return args.job_id ? `读取任务 ${String(args.job_id)} 的输出` : "读取后台任务输出";
    case "job_kill":
      return args.job_id ? `停止任务 ${String(args.job_id)}` : "停止后台任务";
    case "present_files": {
      const files = args.files;
      return Array.isArray(files) ? `呈现 ${files.length} 个产物` : "呈现产物";
    }
    case "show_widget":
      return `${verb} ${String(args.title ?? "可视化")}`;
    case "read_me":
      return "加载可视化设计规范";
    default:
      // Unmapped (MCP servers): the id is the only thing that identifies it.
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
