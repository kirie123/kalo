/**
 * Pure helpers for the orchestrator role (doc/2026-11-12-工作台助理与任务系统.md).
 * No store, no clock, no IPC: the service owns state, this file decides text and pages.
 */
import type { OrchestratorMessage, TaskView } from "../../../shared/workbench";

/** A task status the person has to act on. Only these become notices, everything else stays internal. */
const ATTENTION = new Set(["waiting", "review", "failed"]);

/**
 * One notice line for a state a person must act on, or undefined for routine progress.
 * A worker that finished quietly does not interrupt the orchestrator.
 */
export function noticeFor(task: Pick<TaskView, "id" | "title" | "status">, summary: string): string | undefined {
  if (!ATTENTION.has(task.status)) return undefined;
  const reason = task.status === "review" ? "待验收" : task.status === "failed" ? "需要恢复" : "等你回答";
  const detail = summary.trim() ? `：${summary.trim()}` : "";
  return `[${reason}] ${task.title}（task ${task.id}）${detail}`;
}

const MAX_NOTICES = 20;

/** Keep the newest notices; a long backlog would only spend tokens on stale state. */
export function appendNotice(pending: readonly string[], notice: string): string[] {
  return [...pending, notice].slice(-MAX_NOTICES);
}

export type ReadResource = "tasks" | "profile" | "task";

export interface ReadRequest { resource: string; offset?: number; limit?: number }

/** Parse `tasks`, `profile` or `task:<id>` without letting a model-supplied prefix pick another list. */
export function parseRead(request: ReadRequest): { resource: ReadResource; id?: string; offset: number; limit: number } {
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit 必须在 1~50 之间");
  const resource = request.resource.trim();
  if (resource === "tasks" || resource === "profile") return { resource, offset, limit };
  if (resource.startsWith("task:")) {
    const id = resource.slice(5).trim();
    if (!id) throw new Error("task:<id> 缺少任务 ID");
    return { resource: "task", id, offset, limit };
  }
  throw new Error("未知资源；可用 tasks、profile 或 task:<id>");
}

export interface TaskLine { id: string; title: string; status: string; profile: string; updatedAt: string }

export function taskLine(task: TaskView): TaskLine {
  return { id: task.id, title: task.title, status: task.status, profile: task.profile, updatedAt: task.updatedAt };
}

/** Text of an assistant message, or "" when it carries only tool calls. */
export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const parts = (message as { content?: unknown }).content;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
    .join("")
    .trim();
}

/** A worker turn that ended in tool calls is not a reply: only final prose reaches the person. */
export function isFinalReply(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  const stop = (message as { stopReason?: unknown }).stopReason;
  return role === "assistant" && stop !== "toolUse";
}

const MAX_MESSAGES = 60;

export function pushMessage(
  messages: readonly OrchestratorMessage[] | undefined,
  role: "user" | "orchestrator",
  text: string,
): OrchestratorMessage[] {
  const next = [...(messages ?? []), { at: new Date().toISOString(), role, text }];
  return next.slice(-MAX_MESSAGES);
}

/** The single message that opens a wake turn: person words first, then the batched notices. */
export function wakePrompt(person: readonly string[], notices: readonly string[]): string {
  const parts: string[] = [];
  if (person.length) parts.push(`来自用户的直接消息：\n${person.join("\n\n")}`);
  if (notices.length) parts.push(`需要你处理的执行结果（共 ${notices.length} 条）：\n${notices.map(n => `- ${n}`).join("\n")}`);
  parts.push(
    "看过之后：需要人决定就用 task_ask（一次一个问题）；可以直接交回结果就用 task_reply。没有需要人处理的事就直接结束本轮，不要汇报进度。",
  );
  return parts.join("\n\n");
}

/** Wake only when the newest notice has settled, so a burst becomes one turn. */
export const NOTICE_DEBOUNCE_MS = 1500;

export function shouldWake(
  pending: number,
  person: number,
  busy: boolean,
  lastNoticeAt: string | undefined,
  now: number,
): boolean {
  if (busy) return false;
  // A person waiting on an answer is never delayed by debounce, but still waits for the current turn.
  if (person > 0) return true;
  if (pending === 0) return false;
  if (!lastNoticeAt) return true;
  const at = Date.parse(lastNoticeAt);
  return !Number.isFinite(at) || now - at >= NOTICE_DEBOUNCE_MS;
}
