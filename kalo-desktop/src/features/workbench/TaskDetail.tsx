import { useEffect, useState } from "react";
import type { TaskView, WorkbenchRequest } from "../../../shared/workbench";
import { readFileText } from "../../lib/pi-bridge";
import { PROFILE_LABELS, TASK_LABELS } from "../../lib/workbench-view";
import AppIcon from "../../components/AppIcon";

type Perform = (request: WorkbenchRequest) => Promise<void>;

/** One task: its question or deliverable first, then the run timeline. Runs are attributes of the task, not cards. */
export default function TaskDetail({ task, busy, perform, onError }: { task: TaskView; busy: boolean; perform: Perform; onError: (message: string) => void }) {
  const [answer, setAnswer] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  useEffect(() => { setAnswer(""); setConfirmStop(false); setPreview(null); }, [task.id, task.question?.id]);
  const act = (action: "retry" | "stop" | "accept" | "dispatch" | "withdraw") => void perform({ action, taskId: task.id, actionId: "" });
  async function showFile(path: string, name: string) {
    try {
      const file = await readFileText(path, 128 * 1024);
      setPreview({ name, text: file.binary ? "此成果是二进制文件，可在任务工作目录中查看。" : file.text + (file.truncated ? "\n\n（预览已截断）" : "") });
    } catch (err) { onError(`读取成果失败：${String(err)}`); }
  }
  const ended = ["completed", "stopped", "stopping"].includes(task.status);

  return <article className="wb-detail">
    <div className="wb-detail-heading">
      <span className="wb-status">{TASK_LABELS[task.status]} · {PROFILE_LABELS[task.profile]}</span>
      <h2>{task.title}</h2><p>{task.cwd}</p>
    </div>
    <div className="wb-detail-content">
      {task.status === "waiting" && task.question && <form onSubmit={e => { e.preventDefault(); void perform({ action: "answer", actionId: "", taskId: task.id, questionId: task.question!.id, answer }); }}>
        <h3>{task.question.text}</h3>
        <div className="wb-options">{task.question.options.map(option => <button key={option} type="button" className="wb-button" aria-pressed={answer === option} onClick={() => setAnswer(option)}>{option}</button>)}</div>
        <label>你的回答<textarea value={answer} onChange={e => setAnswer(e.target.value)} maxLength={12000} required /></label>
        <button className="wb-button wb-primary" disabled={busy || !answer.trim()}>回答并继续原任务</button>
      </form>}
      {task.summary && <section><h3>{task.status === "failed" ? "未完成原因" : "交付摘要"}</h3><pre className="wb-summary">{task.summary}</pre></section>}
      {task.artifacts.length > 0 && <div className="wb-artifacts">{task.artifacts.map(file => <button key={file.path} className="wb-button" onClick={() => void showFile(file.path, file.name)}><AppIcon name="file" />{file.name}</button>)}</div>}
      {preview && <section className="wb-file-preview"><div className="wb-row"><strong>{preview.name}</strong><button className="wb-button" onClick={() => setPreview(null)}>关闭预览</button></div><pre>{preview.text}</pre></section>}
      <div className="wb-row">
        {task.status === "todo" && <button className="wb-button wb-primary" disabled={busy} onClick={() => act("dispatch")}>派发执行</button>}
        {task.status === "queued" && task.runs.at(-1)?.status === "queued" && <button className="wb-button" disabled={busy} onClick={() => act("withdraw")}>撤回到待办</button>}
        {task.status === "review" && <button className="wb-button wb-primary" disabled={busy} onClick={() => act("accept")}>确认验收</button>}
        {task.status === "failed" && <button className="wb-button wb-primary" disabled={busy} onClick={() => act("retry")}>恢复原任务</button>}
        {!ended && task.status !== "todo" && <button className="wb-button" disabled={busy} onClick={() => setConfirmStop(true)}>停止任务</button>}
      </div>
      {confirmStop && <div className="wb-confirm">停止后不再自动恢复；已经执行的操作不会被撤回。<div className="wb-row"><button className="wb-button" disabled={busy} onClick={() => act("stop")}>确认停止</button><button className="wb-button" onClick={() => setConfirmStop(false)}>继续保留</button></div></div>}
      <details><summary>目标与授权</summary><dl>
        <dt>目标</dt><dd>{task.goal || "等待确认"}</dd>
        <dt>验收条件</dt><dd>{task.acceptance || "等待确认"}</dd>
        <dt>执行类型</dt><dd>{PROFILE_LABELS[task.profile]}：目录内文件工具{task.allowShell && task.profile !== "research" ? " + 用户授权的本机命令" : "；未开放命令执行"}；不开放嵌套 agent、MCP 或外发</dd>
      </dl></details>
      <details open><summary>执行尝试（{task.runs.length}）</summary>
        <ol className="wb-history">{task.runs.map((run, index) => <li key={run.id}>
          <small>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "尚未启动"}{run.endedAt ? ` → ${new Date(run.endedAt).toLocaleTimeString()}` : ""}</small>
          第 {index + 1} 次 · {run.role === "router" ? "Router" : `Worker（${PROFILE_LABELS[run.profile ?? task.profile]}）`} · {run.status}
        </li>)}</ol>
      </details>
      <details><summary>执行记录</summary><ol className="wb-history">{task.history.map((entry, index) => <li key={index}><small>{new Date(entry.at).toLocaleTimeString()}</small>{entry.text}</li>)}</ol></details>
    </div>
  </article>;
}
