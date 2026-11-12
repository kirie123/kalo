import type { TaskView } from "../../../shared/workbench";
import { PROFILE_LABELS, TASK_LABELS, taskSummary } from "../../lib/workbench-view";

/** Task cards shared by the list view; the board renders the same card via TaskCard. */
export function TaskCard({ task, selected, onSelect, draggable, onDragStart }: {
  task: TaskView; selected: boolean; onSelect: () => void;
  draggable?: boolean; onDragStart?: (event: React.DragEvent) => void;
}) {
  return <button className="wb-task" aria-pressed={selected} onClick={onSelect} draggable={draggable} onDragStart={onDragStart}>
    <span className={`wb-status ${task.status === "failed" ? "wb-failed" : ""}`}>{TASK_LABELS[task.status]}</span>
    <span className="wb-profile">{PROFILE_LABELS[task.profile]}</span>
    <strong>{task.title}</strong>
    <p>{taskSummary(task)}</p>
    <small>{new Date(task.updatedAt).toLocaleString()}{task.runs.length > 1 ? ` · 第 ${task.runs.length} 次尝试` : ""}</small>
  </button>;
}

export default function ListView({ tasks, selected, onSelect, empty }: { tasks: TaskView[]; selected?: string; onSelect: (id: string) => void; empty: string }) {
  return <div className="wb-list">
    {tasks.map(task => <TaskCard key={task.id} task={task} selected={selected === task.id} onSelect={() => onSelect(task.id)} />)}
    {tasks.length === 0 && <div className="wb-empty">{empty}</div>}
  </div>;
}
