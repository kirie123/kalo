import type { TaskRole, TaskView } from "../../../shared/workbench";
export type { TaskRole, TaskView, WorkbenchRequest } from "../../../shared/workbench";

export interface Run {
  id: string; role: TaskRole; token: string; generation: number;
  status: "queued" | "starting" | "running" | "closing" | "ended";
  prompt: string; sessionFile?: string; startedAt?: string;
  report?: { kind: "create" | "ignore" | "question" | "ready" | "failed"; summary: string };
  error?: string; settled?: boolean; ready?: boolean; receipts: Record<string, string>;
}
export interface Task extends Omit<TaskView, "runs"> { generation: number; runs: Run[] }
export interface StartWorker {
  type: "task_worker_start"; runId: string; taskId: string; role: TaskRole;
  cwd: string; sessionFile?: string; endpoint: string; token: string; allowShell: boolean;
}
export type WorkerMessage = StartWorker | { type: "task_worker_prompt"; runId: string; prompt: string } | { type: "task_worker_cancel"; runId: string } | { type: "task_worker_inspect" };
export const activeRun = (task: Task): Run | undefined => [...task.runs].reverse().find(run => run.status !== "ended");
export const sessionId = (runId: string): string => `workbench-${runId}`;
export function view(task: Task): TaskView {
  const { generation: _generation, runs, ...publicTask } = task;
  return { ...publicTask, runs: runs.map(({ id, role, status }) => ({ id, role, status })) };
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
