/**
 * The 演化 panel.
 *
 * Three states, in the order a user moves through them:
 *   list   — workspaces and their runs
 *   gate   — verify the eval before spending anything (`EraGate`)
 *   run    — watch a run: curve, tree, node detail, event stream
 *
 * The run view tails `trace.jsonl` incrementally with `readTextSince` and
 * folds it locally. The trace is era's append-only source of truth — it is
 * flushed per record, so tailing it shows the run as it happens without
 * needing era to expose anything else. `tree.json` is deliberately ignored:
 * era only writes it at the end.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import MetricChart, { type ChartSeries } from "../../components/MetricChart";
import { chatStore } from "../../lib/chat-store";
import { jobStop, openPath, readTextSince } from "../../lib/pi-bridge";
import type { BackgroundJob } from "../../types";
import EraGate from "./EraGate";
import EraNodeDetail from "./EraNodeDetail";
import EraWizard from "./EraWizard";
import { diagnose } from "./diagnose";
import { EraFolder, bestNode, bestSoFarSeries, nodeState } from "./fold";
import {
  TRACE_FILE,
  findRunJob,
  forgetWorkspace,
  listRuns,
  loadWorkspaces,
  readSpec,
  rememberWorkspace,
  startRun,
  type EraRunRef,
} from "./runs";
import type { EraRunSpec } from "./spec";
import type { EraNode, EraTree } from "./types";

const POLL_MS = 1000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmt(n: number | null, digits = 6): string {
  if (n === null) return "—";
  return Number.isInteger(n) ? String(n) : Number(n.toPrecision(digits)).toString();
}

type View =
  | { kind: "list" }
  | { kind: "wizard" }
  | { kind: "gate"; workspace: string; spec: EraRunSpec }
  | { kind: "run"; run: EraRunRef };

export default function EraPanel({ onLeaveToChat }: { onLeaveToChat: () => void }) {
  const [workspaces, setWorkspaces] = useState<string[]>(() => loadWorkspaces());
  const [view, setView] = useState<View>({ kind: "list" });

  const addWorkspace = useCallback(async () => {
    const picked = await open({ directory: true }).catch(() => null);
    if (typeof picked === "string") setWorkspaces(rememberWorkspace(picked));
  }, []);

  if (view.kind === "wizard") {
    return (
      <EraWizard
        onHandoff={(dir) => {
          setWorkspaces(rememberWorkspace(dir));
          setView({ kind: "list" });
          onLeaveToChat();
        }}
        onCancel={() => setView({ kind: "list" })}
      />
    );
  }

  if (view.kind === "gate") {
    const seedDir = view.spec.seed.match(/^([A-Za-z]:[\\/]|\/)/)
      ? view.spec.seed
      : `${view.workspace}/${view.spec.seed}`;
    return (
      <EraGate
        workspace={view.workspace}
        spec={view.spec}
        seedDir={seedDir}
        onCancel={() => setView({ kind: "list" })}
        onAskAgent={(complaint) => {
          chatStore.newChat();
          void chatStore
            .setCwd(view.workspace)
            .then(() => chatStore.sendPrompt(complaint))
            .then(onLeaveToChat)
            .catch((e) => chatStore.pushToast(`没能开始会话：${errText(e)}`, "error"));
        }}
        onStart={() => {
          void startRun(view.workspace, view.spec)
            .then(({ outDir }) => {
              chatStore.pushToast(`已开始演化，输出在 ${outDir}`, "info");
              setView({
                kind: "run",
                run: {
                  dir: outDir,
                  name: view.spec.name,
                  workspace: view.workspace,
                  tracePath: `${outDir}/${TRACE_FILE}`,
                  modifiedMs: 0,
                },
              });
            })
            .catch((e) => chatStore.pushToast(`启动失败：${errText(e)}`, "error"));
        }}
      />
    );
  }

  if (view.kind === "run") {
    return <RunView run={view.run} onBack={() => setView({ kind: "list" })} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge bg-card p-3">
        <div className="text-sm font-medium">演化</div>
        <p className="mt-1 text-xs leading-relaxed text-dim">
          让一个 agent 反复改写你的代码，每改一次就用你的评测脚本打一次分，然后沿着分数高的方向继续改。
          适合"知道怎么算好、但不知道怎么写得更好"的问题。
        </p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => setView({ kind: "wizard" })}
            className="rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-base"
          >
            描述一个新实验
          </button>
          <button
            onClick={() => void addWorkspace()}
            className="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
          >
            打开已有目录
          </button>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <p className="text-xs text-dim">还没有实验目录。</p>
      ) : (
        workspaces.map((ws) => (
          <WorkspaceCard
            key={ws}
            workspace={ws}
            onForget={() => setWorkspaces(forgetWorkspace(ws))}
            onOpenRun={(run) => setView({ kind: "run", run })}
            onVerify={(spec) => setView({ kind: "gate", workspace: ws, spec })}
          />
        ))
      )}
    </div>
  );
}

// ------------------------------------------------------------ workspace card

function WorkspaceCard({
  workspace,
  onForget,
  onOpenRun,
  onVerify,
}: {
  workspace: string;
  onForget: () => void;
  onOpenRun: (run: EraRunRef) => void;
  onVerify: (spec: EraRunSpec) => void;
}) {
  const [runs, setRuns] = useState<EraRunRef[] | null>(null);
  const [spec, setSpec] = useState<Awaited<ReturnType<typeof readSpec>> | null>(null);

  const refresh = useCallback(() => {
    void listRuns(workspace).then(setRuns);
    void readSpec(workspace).then(setSpec);
  }, [workspace]);

  useEffect(refresh, [refresh]);

  return (
    <div className="rounded-lg border border-edge bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="mono min-w-0 flex-1 truncate text-xs" title={workspace}>
          {workspace}
        </span>
        <button onClick={refresh} className="text-xs text-dim hover:text-ink">
          刷新
        </button>
        <button
          onClick={() => void openPath(workspace, false).catch(() => undefined)}
          className="text-xs text-dim hover:text-ink"
        >
          打开
        </button>
        <button onClick={onForget} className="text-xs text-dim hover:text-ink" title="只从列表移除，不删文件">
          移除
        </button>
      </div>

      {spec && (
        <div className="mt-2 text-xs">
          {spec.ok ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-dim">
                {spec.spec.task}
                <span className="mono ml-2">· {spec.spec.evalCmd}</span>
              </span>
              <button
                onClick={() => onVerify(spec.spec)}
                className="shrink-0 rounded-md border border-dim px-2 py-1 text-xs text-ink hover:bg-base"
              >
                验证并开始
              </button>
            </div>
          ) : (
            <span className="text-dim">{spec.error}</span>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1">
        {runs === null ? (
          <span className="text-xs text-dim">读取中…</span>
        ) : runs.length === 0 ? (
          <span className="text-xs text-dim">还没有跑过</span>
        ) : (
          runs.map((r) => (
            <button
              key={r.dir}
              onClick={() => onOpenRun(r)}
              className="flex items-center gap-2 rounded border border-edge px-2 py-1 text-left text-xs hover:bg-base"
            >
              <span className="mono min-w-0 flex-1 truncate">{r.name}</span>
              <span className="shrink-0 text-dim">{new Date(r.modifiedMs).toLocaleString()}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ run view

function RunView({ run, onBack }: { run: EraRunRef; onBack: () => void }) {
  const folderRef = useRef(new EraFolder());
  const offsetRef = useRef(0);
  const [tree, setTree] = useState<EraTree>(() => folderRef.current.snapshot());
  const [selected, setSelected] = useState<number | null>(null);
  const [job, setJob] = useState<BackgroundJob | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const [tick, setTick] = useState(0);

  // Fresh folder whenever the run changes: a folder is per-file state.
  useEffect(() => {
    folderRef.current = new EraFolder();
    offsetRef.current = 0;
    setTree(folderRef.current.snapshot());
    setSelected(null);
  }, [run.tracePath]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const chunk = await readTextSince(run.tracePath, offsetRef.current);
        if (!alive) return;
        if (chunk.reset) {
          // The file shrank: it was replaced or truncated. Start over rather
          // than folding a second run's records onto the first one's tree.
          folderRef.current.reset();
          offsetRef.current = 0;
          const full = await readTextSince(run.tracePath, 0);
          folderRef.current.push(full.text);
          offsetRef.current = full.offset;
        } else if (chunk.text) {
          folderRef.current.push(chunk.text);
          offsetRef.current = chunk.offset;
        }
        setTree(folderRef.current.snapshot());
        setTick((t) => t + 1);
      } catch {
        // A trace that is not there yet is normal right after starting.
      }
      if (alive) timer = setTimeout(() => void poll(), POLL_MS);
    };

    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [run.tracePath]);

  // The backing job, for the stop button and for "did it die without saying so".
  useEffect(() => {
    let alive = true;
    const check = () => {
      void findRunJob(run.name).then((j) => {
        if (alive) setJob(j);
      });
    };
    check();
    const id = setInterval(check, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [run.name]);

  const best = bestNode(tree);
  const problems = useMemo(() => diagnose(tree), [tree]);
  const node = selected === null ? null : tree.nodes.find((n) => n.id === selected) ?? null;

  const series = useMemo<ChartSeries[]>(() => {
    const points = tree.nodes
      .filter((n) => n.score !== null && n.evalOk)
      .map((n) => ({ x: n.id, y: n.score as number, key: n.id }));
    const out: ChartSeries[] = [
      { id: "nodes", label: "每个节点", points, shape: "scatter", color: "var(--dim, #888)" },
      { id: "best", label: "当前最好", points: bestSoFarSeries(tree), color: "var(--ok)" },
    ];
    const holdout = tree.nodes
      .filter((n) => n.holdoutScore !== null && n.holdoutOk !== false)
      .map((n) => ({ x: n.id, y: n.holdoutScore as number, key: n.id }));
    if (holdout.length > 0) {
      out.push({ id: "holdout", label: "留出集", points: holdout, color: "var(--warn, #d29922)", dashed: true });
    }
    return out;
  }, [tree]);

  const events = folderRef.current.events();
  const running = job !== null && (job.status === "running" || job.status === "queued");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-sm text-dim hover:text-ink">
          ← 返回
        </button>
        <span className="mono truncate text-sm">{run.name}</span>
        {job && (
          <span className={`text-xs ${running ? "text-[var(--warn,#d29922)]" : "text-dim"}`}>{job.status}</span>
        )}
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void openPath(run.dir, false).catch(() => undefined)}
            className="text-xs text-dim hover:text-ink"
          >
            打开目录
          </button>
          {running && (
            <button
              onClick={() => void jobStop(job.id, "用户停止").catch(() => undefined)}
              className="text-xs text-dim hover:text-[var(--danger)]"
            >
              停止
            </button>
          )}
        </div>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-4 gap-2">
        <Stat label="最好分数" value={fmt(best?.score ?? null)} sub={best ? best.name : ""} />
        <Stat
          label="进度"
          value={`${tree.nodes.filter((n) => n.parent !== null).length}${tree.budget ? ` / ${tree.budget}` : ""}`}
          sub={`第 ${tree.iteration} 轮`}
        />
        <Stat
          label="花费"
          value={`$${fmt(tree.totalCostUsd, 3)}`}
          sub={tree.costComplete ? "" : "部分节点未报告"}
        />
        <Stat
          label="状态"
          value={tree.finished ? "已结束" : tree.interrupted ? "被中断" : running ? "进行中" : "未在运行"}
          sub={tree.unparsedLines ? `${tree.unparsedLines} 行无法解析` : ""}
        />
      </div>

      {tree.warnings.map((w, i) => (
        <div key={i} className="rounded-md border border-[var(--warn,#d29922)] px-3 py-2 text-xs">
          {w}
        </div>
      ))}

      {problems.map((p) => (
        <div
          key={p.id}
          className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${
            p.tone === "danger" ? "border-[var(--danger)]" : "border-[var(--warn,#d29922)]"
          }`}
        >
          <div className="font-medium">
            {p.title} <span className="mono ml-1 font-normal text-dim">{p.detail}</span>
          </div>
          <div className="mt-0.5 text-dim">{p.hint}</div>
          {p.nodeIds.length > 0 && (
            <div className="mt-1 flex gap-2">
              {p.nodeIds.map((id) => (
                <button key={id} onClick={() => setSelected(id)} className="mono underline hover:text-ink">
                  看 n{String(id).padStart(4, "0")}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      {job && !running && !tree.finished && !tree.interrupted && (
        <div className="rounded-md border border-[var(--danger)] px-3 py-2 text-xs leading-relaxed">
          进程已经结束（{job.status}），但 trace 里没有结束记录。
          {tree.nodes.length === 0
            ? " 一个节点都没建出来，最常见的原因是 PATH 上找不到 era —— 如果它装在 venv 里，在 era-run.json 里加一行 \"eraBin\": \"<era 可执行文件的完整路径>\"。"
            : " 多半是 era 自己崩了，日志在「任务」面板里。"}
          {job.detail && <div className="mono mt-1 text-dim">{job.detail}</div>}
        </div>
      )}

      <MetricChart
        series={series}
        height={200}
        xLabel="节点"
        yLabel="分数"
        subtitle={`${tree.metricGoal === "max" ? "越大越好" : "越小越好"}；失败的评测不画在图上（era 会把它们记成最差分数）`}
        selectedKey={selected}
        onSelect={(_, p) => setSelected(typeof p.key === "number" ? p.key : null)}
        emptyHint="还没有评测结果"
      />

      <div className="flex min-h-0 gap-3">
        <div className="max-h-[26rem] w-64 shrink-0 overflow-y-auto rounded-lg border border-edge bg-card">
          <NodeList tree={tree} selected={selected} onSelect={setSelected} />
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-edge bg-card">
          {node ? (
            <EraNodeDetail runDir={run.dir} tree={tree} node={node} onSelectNode={setSelected} />
          ) : (
            <p className="p-3 text-xs text-dim">从左边或图上选一个节点。</p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-edge bg-card">
        <button
          onClick={() => setShowEvents((v) => !v)}
          className="w-full px-3 py-2 text-left text-xs text-dim hover:text-ink"
        >
          {showEvents ? "▾" : "▸"} 事件流（最近 {events.length} 条）
        </button>
        {showEvents && (
          <div className="max-h-64 overflow-y-auto px-3 pb-2" key={tick}>
            {events.map((e) => (
              <div
                key={e.seq}
                className={`mono flex gap-2 py-px text-[10px] ${e.failure ? "text-[var(--danger)]" : "text-dim"}`}
              >
                <span className="w-14 shrink-0 text-right">
                  {e.timeMs === null ? "" : new Date(e.timeMs).toLocaleTimeString()}
                </span>
                {e.nodeId === null ? (
                  <span className="w-10 shrink-0" />
                ) : (
                  <button onClick={() => setSelected(e.nodeId)} className="w-10 shrink-0 underline hover:text-ink">
                    n{String(e.nodeId).padStart(4, "0")}
                  </button>
                )}
                <span className="min-w-0 flex-1 break-words">{e.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-card px-3 py-2">
      <div className="text-[10px] text-dim">{label}</div>
      <div className="mono truncate text-lg">{value}</div>
      {sub && <div className="truncate text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

/** The tree as an indented list: cheap, scannable, and stable while it grows. */
function NodeList({
  tree,
  selected,
  onSelect,
}: {
  tree: EraTree;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const depth = useMemo(() => {
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    const d = new Map<number, number>();
    const compute = (n: EraNode): number => {
      const seen = d.get(n.id);
      if (seen !== undefined) return seen;
      // Guard against a malformed trace claiming a node is its own ancestor.
      d.set(n.id, 0);
      const parent = n.parent === null ? null : byId.get(n.parent);
      const v = parent ? compute(parent) + 1 : 0;
      d.set(n.id, v);
      return v;
    };
    tree.nodes.forEach(compute);
    return d;
  }, [tree.nodes]);

  const bestId = bestNode(tree)?.id ?? null;

  return (
    <div className="flex flex-col py-1">
      {tree.nodes.length === 0 && <span className="px-3 py-2 text-xs text-dim">还没有节点</span>}
      {tree.nodes.map((n) => {
        const st = nodeState(n);
        const color =
          st === "ok"
            ? "text-ink"
            : st === "eval_failed" || st === "mutation_failed"
              ? "text-[var(--danger)]"
              : "text-[var(--warn,#d29922)]";
        return (
          <button
            key={n.id}
            onClick={() => onSelect(n.id)}
            className={`flex items-baseline gap-1.5 px-2 py-0.5 text-left text-xs hover:bg-base ${
              selected === n.id ? "bg-base" : ""
            }`}
            style={{ paddingLeft: 8 + (depth.get(n.id) ?? 0) * 10 }}
          >
            <span className={`mono shrink-0 ${color}`}>{n.name}</span>
            <span className="mono min-w-0 flex-1 truncate text-dim">{fmt(n.score, 5)}</span>
            {n.id === bestId && <span className="shrink-0 text-[10px] text-[var(--ok)]">最好</span>}
          </button>
        );
      })}
    </div>
  );
}
