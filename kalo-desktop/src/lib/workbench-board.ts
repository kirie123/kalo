/**
 * Board projection for the workbench (doc/2026-11-12-工作台助理与任务系统.md).
 * Columns are a view over task status, never a second state machine; a drop maps to
 * exactly one legal workbench action or is refused with a reason.
 */
import type { TaskStatus, TaskView } from "../../shared/workbench";

export type BoardColumn = "todo" | "queued" | "active" | "attention" | "done";
export const BOARD_COLUMNS: readonly { id: BoardColumn; label: string }[] = [
  { id: "todo", label: "待办" },
  { id: "queued", label: "排队中" },
  { id: "active", label: "执行中" },
  { id: "attention", label: "需要你" },
  { id: "done", label: "已完成" },
];

const COLUMN_OF: Record<TaskStatus, BoardColumn> = {
  todo: "todo",
  queued: "queued",
  routing: "active", running: "active", settling: "active", stopping: "active",
  waiting: "attention", review: "attention", failed: "attention",
  completed: "done", stopped: "done",
};
export const columnOf = (status: TaskStatus): BoardColumn => COLUMN_OF[status];

/** Newest first inside a column, matching the list view. */
export function groupByColumn(tasks: readonly TaskView[]): Record<BoardColumn, TaskView[]> {
  const groups: Record<BoardColumn, TaskView[]> = { todo: [], queued: [], active: [], attention: [], done: [] };
  for (const task of tasks) groups[columnOf(task.status)].push(task);
  for (const list of Object.values(groups)) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return groups;
}

export type DropResult = { action: "dispatch" | "withdraw" } | { refused: string };

/** Only todo⇄queued are drag gestures; every other transition needs its explicit button. */
export function dropAction(task: Pick<TaskView, "status">, to: BoardColumn): DropResult | undefined {
  const from = columnOf(task.status);
  if (from === to) return undefined;
  if (from === "todo" && to === "queued") return { action: "dispatch" };
  if (from === "queued" && to === "todo") return { action: "withdraw" };
  if (to === "done") return { refused: "完成需要在详情里验收或停止，不能拖拽" };
  if (to === "attention") return { refused: "「需要你」由执行结果决定，不能手动移入" };
  if (to === "active") return { refused: "执行由调度器启动，请拖到「排队中」派发" };
  return { refused: "此任务已开始执行，不能退回；需要时请在详情里停止" };
}
