import type { TaskView } from "../../../shared/workbench";
import { PROFILE_LABELS } from "../../lib/workbench-view";

/** Live agent sessions across all tasks. A session is a run whose process has not ended. */
export function liveSessions(tasks: readonly TaskView[]) {
  return tasks.flatMap(task => task.runs.filter(run => run.status !== "ended").map(run => ({ task, run })))
    .sort((a, b) => (a.run.startedAt ?? "~").localeCompare(b.run.startedAt ?? "~"));
}

const RUN_LABELS: Record<string, string> = { queued: "排队", starting: "启动中", running: "运行中", closing: "收尾中" };

export default function SessionView({ tasks, onSelect }: { tasks: TaskView[]; onSelect: (id: string) => void }) {
  const sessions = liveSessions(tasks);
  return <div className="wb-sessions">
    <table>
      <thead><tr><th>角色</th><th>任务</th><th>状态</th><th>开始</th></tr></thead>
      <tbody>
        {sessions.map(({ task, run }) => <tr key={run.id} onClick={() => onSelect(task.id)}>
          <td>{run.role === "router" ? "Router" : `Worker · ${PROFILE_LABELS[run.profile ?? task.profile]}`}</td>
          <td>{task.title}</td>
          <td>{RUN_LABELS[run.status] ?? run.status}</td>
          <td>{run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "—"}</td>
        </tr>)}
      </tbody>
    </table>
    {sessions.length === 0 && <div className="wb-empty">当前没有正在运行的 agent 会话。</div>}
  </div>;
}
