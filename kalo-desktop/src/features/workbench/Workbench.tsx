import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { TaskView, WorkbenchRequest } from "../../../shared/workbench";
import { onWorkbenchChanged, readFileText, workbenchRequest } from "../../lib/pi-bridge";
import { isActiveTask, needsAttention, TASK_LABELS, taskSummary } from "../../lib/workbench-view";
import AppIcon from "../../components/AppIcon";
import "./workbench.css";

export default function Workbench({ cwd: defaultCwd }: { cwd: string }) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"inbox" | "all">("inbox");
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [allowShell, setAllowShell] = useState(false);
  const [answer, setAnswer] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const alive = useRef(true);
  const refreshing = useRef(false);
  const actionId = useRef<{ fingerprint: string; id: string } | null>(null);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const reply = await workbenchRequest({ action: "list" });
      if (!reply.ok || !reply.tasks) throw new Error(reply.error || "工作台没有返回任务列表");
      if (alive.current) { setTasks(reply.tasks); setLoaded(true); setConnectionError(""); }
    } catch (err) { if (alive.current) setConnectionError(`工作台暂不可用：${String(err)}`); }
    finally { refreshing.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = onWorkbenchChanged(() => { void refresh(); }).catch(() => undefined);
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { alive.current = false; clearInterval(timer); void unsubscribe.then(fn => fn?.()); };
  }, [refresh]);
  const list = tab === "inbox" ? tasks.filter(needsAttention) : tasks;
  const task = list.find(t => t.id === selected) ?? list[0];
  useEffect(() => { setAnswer(""); setConfirmStop(false); setPreview(null); }, [task?.id, task?.question?.id]);

  async function perform(request: WorkbenchRequest) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      // Preserve action IDs across a timed-out retry of the same UI operation.
      const fingerprint = JSON.stringify({ ...request, actionId: undefined });
      if (actionId.current?.fingerprint !== fingerprint) actionId.current = { fingerprint, id: crypto.randomUUID() };
      const reply = await workbenchRequest({ ...request, actionId: actionId.current.id } as WorkbenchRequest);
      if (!reply.ok || !reply.tasks) throw new Error(reply.error || "任务操作失败");
      setTasks(reply.tasks); actionId.current = null;
      if (request.action === "create") { setCreating(false); setPrompt(""); setTab("all"); setSelected(reply.tasks[0]?.id ?? ""); }
      setAnswer(""); setConfirmStop(false);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  const act = (action: "retry" | "stop" | "accept") => task && void perform({ action, taskId: task.id, actionId: "" });
  async function showFile(path: string, name: string) {
    try {
      const file = await readFileText(path, 128 * 1024);
      setPreview({ name, text: file.binary ? "此成果是二进制文件，可在任务工作目录中查看。" : file.text + (file.truncated ? "\n\n（预览已截断）" : "") });
    } catch (err) { setError(`读取成果失败：${String(err)}`); }
  }

  return <div className="workbench">
    <aside className="workbench-sidebar">
      <h2>工作台</h2><p>让每项委托都有交付</p>
      <button aria-current={tab === "inbox" ? "page" : undefined} onClick={() => setTab("inbox")}><AppIcon name="inbox" />需要你<span>{tasks.filter(needsAttention).length}</span></button>
      <button aria-current={tab === "all" ? "page" : undefined} onClick={() => setTab("all")}><AppIcon name="checklist" />全部任务<span>{tasks.length}</span></button>
      <div className="workbench-sidebar-note">Router 确定目标<br />Worker 独立执行<br />有结果或问题时，再回来</div>
    </aside>
    <section className="workbench-main">
      <header><div><h1>{tab === "inbox" ? "需要你的，只有这些" : "每项委托，都有去处"}</h1><p>{tasks.filter(isActiveTask).length} 项进行中 · 应用退出会中断执行</p></div><button className="wb-button wb-primary" onClick={() => setCreating(v => !v)}><AppIcon name="plus" />新委托</button></header>
      {(error || connectionError) && <div className="wb-error" role="alert">{error || connectionError}<button className="wb-button" onClick={() => { setError(""); void refresh(); }}>刷新状态</button></div>}
      {creating && <form className="wb-create" onSubmit={e => { e.preventDefault(); void perform({ action: "create", actionId: "", prompt, cwd, allowShell }); }}>
        <label>希望完成什么？<textarea value={prompt} onChange={e => setPrompt(e.target.value)} required maxLength={12000} placeholder="例如：整理这个目录的研究资料，生成一份带出处的摘要。" /></label>
        <label>工作目录<div className="wb-row"><input value={cwd} onChange={e => setCwd(e.target.value)} required /><button type="button" className="wb-button" onClick={() => { void open({ directory: true }).then(dir => { if (typeof dir === "string") setCwd(dir); }).catch(err => setError(String(err))); }}>选择目录</button></div></label>
        <label className="wb-checkbox"><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} />允许执行本机命令（可访问本机资源，不是隔离沙箱）</label>
        <p>默认只开放任务目录内的文件工具。Router 和 Worker 使用已配置的默认模型；本期不自动接管聊天或定时任务。</p>
        <div className="wb-row"><button className="wb-button wb-primary" disabled={busy || !prompt.trim() || !cwd.trim()}>交给 Router</button><button type="button" className="wb-button" onClick={() => setCreating(false)}>取消</button></div>
      </form>}
      {!loaded && !connectionError && <p className="wb-empty">正在连接任务服务…</p>}
      {loaded && <div className="wb-columns">
        <div className="wb-list">{list.map(item => <button key={item.id} className="wb-task" aria-pressed={task?.id === item.id} onClick={() => setSelected(item.id)}>
          <span className={`wb-status ${item.status === "failed" ? "wb-failed" : ""}`}>{TASK_LABELS[item.status]}</span><strong>{item.title}</strong><p>{taskSummary(item)}</p><small>{new Date(item.updatedAt).toLocaleString()}</small>
        </button>)}{list.length === 0 && <div className="wb-empty">{tab === "inbox" ? "暂时没有需要你处理的事。" : "还没有委托，从「新委托」开始。"}</div>}</div>
        {task && <article className="wb-detail">
          <div className="wb-detail-heading"><span className="wb-status">{TASK_LABELS[task.status]}</span><h2>{task.title}</h2><p>{task.cwd}</p></div>
          <div className="wb-detail-content">
            {task.status === "waiting" && task.question && <form onSubmit={e => { e.preventDefault(); void perform({ action: "answer", actionId: "", taskId: task.id, questionId: task.question!.id, answer }); }}>
              <h3>{task.question.text}</h3><div className="wb-options">{task.question.options.map(option => <button key={option} type="button" className="wb-button" aria-pressed={answer === option} onClick={() => setAnswer(option)}>{option}</button>)}</div>
              <label>你的回答<textarea value={answer} onChange={e => setAnswer(e.target.value)} maxLength={12000} required /></label><button className="wb-button wb-primary" disabled={busy || !answer.trim()}>回答并继续原任务</button>
            </form>}
            {task.summary && <section><h3>{task.status === "failed" ? "未完成原因" : "交付摘要"}</h3><pre className="wb-summary">{task.summary}</pre></section>}
            {task.artifacts.length > 0 && <div className="wb-artifacts">{task.artifacts.map(file => <button key={file.path} className="wb-button" onClick={() => void showFile(file.path, file.name)}><AppIcon name="file" />{file.name}</button>)}</div>}
            {preview && <section className="wb-file-preview"><div className="wb-row"><strong>{preview.name}</strong><button className="wb-button" onClick={() => setPreview(null)}>关闭预览</button></div><pre>{preview.text}</pre></section>}
            <div className="wb-row">
              {task.status === "review" && <button className="wb-button wb-primary" disabled={busy} onClick={() => act("accept")}>确认验收</button>}
              {task.status === "failed" && <button className="wb-button wb-primary" disabled={busy} onClick={() => act("retry")}>恢复原任务</button>}
              {!["completed", "stopped", "stopping"].includes(task.status) && <button className="wb-button" disabled={busy} onClick={() => setConfirmStop(true)}>停止任务</button>}
            </div>
            {confirmStop && <div className="wb-confirm">停止后不再自动恢复；已经执行的操作不会被撤回。<div className="wb-row"><button className="wb-button" disabled={busy} onClick={() => act("stop")}>确认停止</button><button className="wb-button" onClick={() => setConfirmStop(false)}>继续保留</button></div></div>}
            <details><summary>目标与授权</summary><dl><dt>目标</dt><dd>{task.goal || "等待 Router 判断"}</dd><dt>验收条件</dt><dd>{task.acceptance || "等待 Router 判断"}</dd><dt>工具范围</dt><dd>目录内文件工具{task.allowShell ? " + 用户授权的本机命令" : "；未开放命令执行"}；不开放嵌套 agent、MCP 或外发</dd></dl></details>
            <details open><summary>执行记录</summary><ol className="wb-history">{task.history.map((entry, index) => <li key={index}><small>{new Date(entry.at).toLocaleTimeString()}</small>{entry.text}</li>)}</ol><p>{task.runs.length} 次执行尝试 · {task.runs.at(-1)?.role === "router" ? "Router" : "Worker"}</p></details>
          </div>
        </article>}
      </div>}
    </section>
  </div>;
}
