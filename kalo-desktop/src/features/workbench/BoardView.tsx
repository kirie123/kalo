import { useState } from "react";
import type { TaskView, WorkbenchRequest } from "../../../shared/workbench";
import { BOARD_COLUMNS, dropAction, groupByColumn, type BoardColumn } from "../../lib/workbench-board";
import { TaskCard } from "./ListView";

const DRAG_TYPE = "application/x-kalo-task";

/** Five columns projected from task status. A drop is either one legal action or a stated refusal. */
export default function BoardView({ tasks, selected, onSelect, perform, onRefused }: {
  tasks: TaskView[]; selected?: string; onSelect: (id: string) => void;
  perform: (request: WorkbenchRequest) => Promise<void>; onRefused: (reason: string) => void;
}) {
  const groups = groupByColumn(tasks);
  const [over, setOver] = useState<BoardColumn | null>(null);
  function drop(event: React.DragEvent, column: BoardColumn) {
    event.preventDefault();
    setOver(null);
    const task = tasks.find(t => t.id === event.dataTransfer.getData(DRAG_TYPE));
    if (!task) return;
    const result = dropAction(task, column);
    if (!result) return;
    if ("refused" in result) { onRefused(result.refused); return; }
    void perform({ action: result.action, taskId: task.id, actionId: "" });
  }
  return <div className="wb-board">
    {BOARD_COLUMNS.map(column => <section key={column.id} className="wb-board-column" data-over={over === column.id || undefined}
      onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOver(column.id); } }}
      onDragLeave={() => setOver(o => (o === column.id ? null : o))}
      onDrop={e => drop(e, column.id)}>
      <header><h3>{column.label}</h3><span>{groups[column.id].length}</span></header>
      <div className="wb-board-cards">
        {groups[column.id].map(task => <TaskCard key={task.id} task={task} selected={selected === task.id} onSelect={() => onSelect(task.id)}
          draggable onDragStart={e => { e.dataTransfer.setData(DRAG_TYPE, task.id); e.dataTransfer.effectAllowed = "move"; }} />)}
      </div>
    </section>)}
  </div>;
}
