import type { TaskStatus, TaskView } from "../../shared/workbench";
export const TASK_LABELS: Record<TaskStatus, string> = {
  routing: "Router 接单中", queued: "等待 Worker", running: "Worker 执行中", settling: "执行结算中",
  waiting: "等你回答", review: "待验收", completed: "已完成", failed: "需要恢复", stopping: "停止中", stopped: "已停止",
};
export const needsAttention = (task: Pick<TaskView, "status">): boolean => ["waiting", "review", "failed"].includes(task.status);
export const isActiveTask = (task: Pick<TaskView, "status">): boolean => ["routing", "queued", "running", "settling", "stopping"].includes(task.status);
export function taskSummary(task: TaskView): string {
  if (task.status === "waiting") return task.question?.text ?? "等待补充信息";
  if (task.status === "review") return "成果已准备好，等待你验收。";
  if (task.status === "failed") return task.summary || "执行未完成，请查看记录后重试。";
  return task.history.at(-1)?.text ?? task.prompt;
}
