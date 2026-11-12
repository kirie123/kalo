import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskView, WorkbenchRequest } from "../../../shared/workbench";
import { onWorkbenchChanged, workbenchRequest } from "../../lib/pi-bridge";
import { isActiveTask, needsAttention } from "../../lib/workbench-view";
import AppIcon from "../../components/AppIcon";
import BoardView from "./BoardView";
import CreateTask from "./CreateTask";
import ListView from "./ListView";
import SessionView, { liveSessions } from "./SessionView";
import TaskDetail from "./TaskDetail";
import "./workbench.css";

type Filter = "inbox" | "all";
type Layout = "list" | "board" | "sessions";
const LAYOUT_KEY = "kalo.workbench.layout";
const LAYOUTS: { id: Layout; label: string }[] = [{ id: "list", label: "列表" }, { id: "board", label: "看板" }, { id: "sessions", label: "会话" }];

export default function Workbench({ cwd: defaultCwd }: { cwd: string }) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<Layout>(() => {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved === "list" || saved === "board" || saved === "sessions" ? saved : "board";
  });
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
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
  useEffect(() => { localStorage.setItem(LAYOUT_KEY, layout); }, [layout]);

  const perform = useCallback(async (request: WorkbenchRequest) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      // Preserve action IDs across a timed-out retry of the same UI operation.
      const fingerprint = JSON.stringify({ ...request, actionId: undefined });
      if (actionId.current?.fingerprint !== fingerprint) actionId.current = { fingerprint, id: crypto.randomUUID() };
      const reply = await workbenchRequest({ ...request, actionId: actionId.current.id } as WorkbenchRequest);
      if (!reply.ok || !reply.tasks) throw new Error(reply.error || "任务操作失败");
      setTasks(reply.tasks); actionId.current = null;
      if (request.action === "create") { setCreating(false); setFilter("all"); setSelected(reply.tasks[0]?.id ?? ""); }
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }, [busy]);

  const attention = tasks.filter(needsAttention);
  const visible = filter === "inbox" ? attention : tasks;
  const task = visible.find(t => t.id === selected) ?? (layout === "list" ? visible[0] : undefined);
  const select = (id: string) => setSelected(current => (layout !== "list" && current === id ? "" : id));

  return <div className="workbench">
    <aside className="workbench-sidebar">
      <h2>工作台</h2>
      <button aria-current={filter === "inbox" ? "page" : undefined} onClick={() => setFilter("inbox")}><AppIcon name="inbox" />需要你<span>{attention.length}</span></button>
      <button aria-current={filter === "all" ? "page" : undefined} onClick={() => setFilter("all")}><AppIcon name="checklist" />全部任务<span>{tasks.length}</span></button>
      <div className="workbench-sidebar-note">任务在后台由独立 agent 会话执行；会话可重试多次，任务只有一个。</div>
    </aside>
    <section className="workbench-main">
      <header>
        <div>
          <h1>{filter === "inbox" ? "待处理" : "全部任务"}</h1>
          <p className="wb-run-context"><span>{tasks.filter(isActiveTask).length} 项进行中</span><span>{liveSessions(tasks).length} 个 agent 会话</span><span>退出应用会中断执行</span></p>
        </div>
        <div className="wb-header-actions">
          <div className="wb-segmented" role="tablist" aria-label="视图">
            {LAYOUTS.map(item => <button key={item.id} role="tab" aria-selected={layout === item.id} onClick={() => setLayout(item.id)}>{item.label}</button>)}
          </div>
          <button className="wb-button wb-primary" onClick={() => setCreating(v => !v)}><AppIcon name="plus" />新任务</button>
        </div>
      </header>
      {(error || connectionError) && <div className="wb-error" role="alert">{error || connectionError}<button className="wb-button" onClick={() => { setError(""); void refresh(); }}>刷新状态</button></div>}
      {creating && <CreateTask defaultCwd={defaultCwd} busy={busy} perform={perform} onCancel={() => setCreating(false)} onError={setError} />}
      {!loaded && !connectionError && <p className="wb-empty">正在连接任务服务…</p>}
      {loaded && <div className={`wb-layout wb-layout-${layout}`} data-detail={task ? "open" : undefined}>
        <div className="wb-layout-main">
          {layout === "list" && <ListView tasks={visible} selected={task?.id} onSelect={select} empty={filter === "inbox" ? "暂时没有需要你处理的事。" : "还没有任务，从「新任务」开始。"} />}
          {layout === "board" && <BoardView tasks={visible} selected={task?.id} onSelect={select} perform={perform} onRefused={setError} />}
          {layout === "sessions" && <SessionView tasks={tasks} onSelect={select} />}
        </div>
        {task && <TaskDetail task={task} busy={busy} perform={perform} onError={setError} />}
      </div>}
    </section>
  </div>;
}
