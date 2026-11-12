import type { TaskRole, TaskView, WorkerProfile } from "../../../shared/workbench";
export type { TaskRole, TaskView, WorkbenchRequest, WorkerProfile } from "../../../shared/workbench";
export { WORKER_PROFILES } from "../../../shared/workbench";

export interface Run {
  id: string; role: TaskRole; token: string; generation: number;
  status: "queued" | "starting" | "running" | "closing" | "ended";
  prompt: string; sessionFile?: string; startedAt?: string; endedAt?: string;
  /** Worker tool set frozen at dispatch; a later profile change applies to the next run only. */
  profile?: WorkerProfile;
  report?: { kind: "create" | "ignore" | "question" | "ready" | "failed"; summary: string };
  error?: string; settled?: boolean; ready?: boolean; receipts: Record<string, string>;
}
/** Rows written before profiles existed lack these fields; `normalize` fills them on read. */
export interface Task extends Omit<TaskView, "runs"> { generation: number; runs: Run[] }
export function normalize(task: Task): Task {
  task.profile ??= "code";
  task.resumeCount ??= 0;
  return task;
}
/**
 * Every profile reads and writes inside the task directory (a research task still writes its report).
 * research never gets bash, even when the task allows it; code/data get bash only with allowShell.
 */
const FILE_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];
export const FILE_TOOL_NAMES: readonly string[] = FILE_TOOLS;
export function workerTools(profile: WorkerProfile, allowShell: boolean): string[] {
  const tools = ["task_context", "task_report", "task_ask", ...FILE_TOOLS];
  if (allowShell && profile !== "research") tools.push("bash");
  return tools;
}
export const ROUTER_TOOLS: readonly string[] = ["task_context", "task_decide", "task_ask"];
export function runTools(run: Pick<Run, "role" | "profile">, task: Pick<Task, "profile" | "allowShell">): string[] {
  return run.role === "router" ? [...ROUTER_TOOLS] : workerTools(run.profile ?? task.profile, task.allowShell);
}
export interface StartWorker {
  type: "task_worker_start"; runId: string; taskId: string; role: TaskRole;
  cwd: string; sessionFile?: string; endpoint: string; token: string; allowShell: boolean;
  /** Effective tool allowlist; the engine activates exactly these, the gateway gate re-checks. */
  tools: string[];
}
export type WorkerMessage = StartWorker | { type: "task_worker_prompt"; runId: string; prompt: string } | { type: "task_worker_cancel"; runId: string } | { type: "task_worker_inspect" };
export const activeRun = (task: Task): Run | undefined => [...task.runs].reverse().find(run => run.status !== "ended");
export const sessionId = (runId: string): string => `workbench-${runId}`;
export function view(task: Task): TaskView {
  const { generation: _generation, runs, ...publicTask } = task;
  return { ...publicTask, runs: runs.map(({ id, role, status, profile, startedAt, endedAt }) => ({ id, role, status, profile, startedAt, endedAt })) };
}
export function record(task: Task, text: string): void {
  task.updatedAt = new Date().toISOString();
  task.history.push({ at: task.updatedAt, text });
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是对象");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 不能为空且不得超过 ${max} 字符`);
  return value.trim();
}
