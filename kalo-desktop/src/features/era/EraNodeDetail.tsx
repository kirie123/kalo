/**
 * One node, in enough detail to answer "why did this happen".
 *
 * The five tabs correspond to the five places evidence lives: the folded trace
 * (概览), the filesystem (改了什么), the instruction era handed the agent
 * (指令), the eval's own output (评测输出), and the agent's step-by-step
 * engine log (引擎轨迹). Nothing here is inferred — every tab shows something
 * era actually wrote down.
 */

import { useCallback, useEffect, useState } from "react";
import DiffView from "../../components/DiffView";
import { openPath, readFileText } from "../../lib/pi-bridge";
import { diffText } from "../../lib/text-diff";
import { nodeState } from "./fold";
import { nodeDiffNames } from "./runs";
import type { EraNode, EraTree } from "./types";

const STATE_LABEL: Record<ReturnType<typeof nodeState>, string> = {
  mutating: "改写中",
  evaluating: "评测中",
  ok: "已评测",
  eval_failed: "评测失败",
  mutation_failed: "改写失败",
};

const STATE_COLOR: Record<ReturnType<typeof nodeState>, string> = {
  mutating: "text-[var(--warn,#d29922)]",
  evaluating: "text-[var(--warn,#d29922)]",
  ok: "text-[var(--ok)]",
  eval_failed: "text-[var(--danger)]",
  mutation_failed: "text-[var(--danger)]",
};

type Tab = "overview" | "changes" | "instruction" | "evalout" | "engine";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "changes", label: "改了什么" },
  { id: "instruction", label: "指令" },
  { id: "evalout", label: "评测输出" },
  { id: "engine", label: "引擎轨迹" },
];

function fmt(n: number | null | undefined, digits = 6): string {
  if (n === null || n === undefined) return "—";
  return Number.isInteger(n) ? String(n) : Number(n.toPrecision(digits)).toString();
}

export default function EraNodeDetail({
  runDir,
  tree,
  node,
  onSelectNode,
}: {
  runDir: string;
  tree: EraTree;
  node: EraNode;
  onSelectNode: (id: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const state = nodeState(node);
  const parent = node.parent === null ? null : tree.nodes.find((n) => n.id === node.parent) ?? null;
  const nodeDir = node.path ? `${runDir}/${node.path}` : null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-baseline gap-2 border-b border-edge px-3 py-2">
        <span className="mono text-sm">{node.name}</span>
        <span className={`text-xs ${STATE_COLOR[state]}`}>{STATE_LABEL[state]}</span>
        <span className="mono text-sm">{fmt(node.score)}</span>
        {parent && (
          <button
            onClick={() => onSelectNode(parent.id)}
            className="mono text-xs text-dim underline hover:text-ink"
            title="跳到父节点"
          >
            父 {parent.name}
          </button>
        )}
        {nodeDir && (
          <button
            onClick={() => void openPath(nodeDir, false).catch(() => undefined)}
            className="ml-auto text-xs text-dim hover:text-ink"
          >
            打开目录
          </button>
        )}
      </div>

      <div className="flex gap-1 border-b border-edge px-2 py-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded px-2 py-0.5 text-xs ${
              tab === t.id ? "bg-base text-ink" : "text-dim hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "overview" && <Overview node={node} parent={parent} tree={tree} />}
        {tab === "changes" && <Changes runDir={runDir} node={node} parent={parent} />}
        {tab === "instruction" && (
          <FileTab path={nodeDir ? `${nodeDir}/.era/instruction.md` : null} empty="这个节点没有指令文件（seed 节点没有经过改写）" />
        )}
        {tab === "evalout" && <EvalOutput node={node} nodeDir={nodeDir} />}
        {tab === "engine" && <EngineTrace path={nodeDir ? `${nodeDir}/.era/engine-trace.jsonl` : null} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 概览

function Overview({ node, parent, tree }: { node: EraNode; parent: EraNode | null; tree: EraTree }) {
  const delta = parent && node.score !== null && parent.score !== null ? node.score - parent.score : null;
  const improved = delta === null ? null : tree.metricGoal === "max" ? delta > 0 : delta < 0;
  const rows: Array<[string, string]> = [
    ["分数", fmt(node.score)],
    ["相对父节点", delta === null ? "—" : `${delta > 0 ? "+" : ""}${fmt(delta)}${improved === null ? "" : improved ? "（更好）" : "（更差）"}`],
    ["算子", node.operator + (node.donors.length ? ` ← ${node.donors.join(", ")}` : "")],
    ["访问次数", String(node.numVisits)],
    ["花费", node.costKnown ? `$${fmt(node.costUsd, 3)}` : `$${fmt(node.costUsd, 3)}（不完整）`],
    ["改写步数", node.llmSteps === null ? "—" : `${node.llmSteps} 步 / ${node.toolCalls ?? "?"} 次工具`],
    ["模型", node.model ?? "—"],
    ["评测耗时", node.evalDurationS === null ? "—" : `${fmt(node.evalDurationS, 3)}s`],
    ["产生于第几轮", node.iteration === null ? "—" : String(node.iteration)],
  ];
  if (node.samples.length > 1) {
    rows.push(["重复评测", `${node.samples.map((s) => fmt(s, 4)).join(", ")}（std ${fmt(node.scoreStd, 3)}）`]);
    rows.push(["排序用分数", fmt(node.selectionScore)]);
  }
  if (node.holdoutScore !== null || node.holdoutOk !== null) {
    rows.push(["留出集", node.holdoutOk === false ? `失败：${node.holdoutReason ?? ""}` : fmt(node.holdoutScore)]);
  }
  if (node.rankScore !== null) {
    rows.push(["选择排名分 / PUCT", `${fmt(node.rankScore, 4)} / ${fmt(node.puct, 4)}`]);
  }

  return (
    <div className="flex flex-col gap-3">
      {!node.mutationOk && node.mutationReason && (
        <Callout tone="danger" title="改写失败">
          {node.mutationReason}
        </Callout>
      )}
      {node.score !== null && !node.evalOk && (
        <Callout tone="danger" title="评测失败">
          {node.evalReason ?? "未知原因"}（退出码 {node.evalReturncode ?? "—"}）
          <div className="mt-1 text-dim">
            era 把失败的评测记成最差分数，所以这个节点的分数不代表程序质量。
          </div>
        </Callout>
      )}
      {node.holdoutScore !== null && node.score !== null && node.holdoutOk !== false && (
        <Callout tone={overfitting(node, tree) ? "warn" : "ok"} title="留出集对照">
          训练分 {fmt(node.score)} / 留出分 {fmt(node.holdoutScore)}
          {overfitting(node, tree) && "：训练分明显好于留出分，可能是在过拟合评测集。"}
        </Callout>
      )}

      <dl className="mono grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-dim">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>

      {node.lastAgentMessage && (
        <div>
          <div className="mb-1 text-xs text-dim">改写 agent 最后说的话</div>
          <pre className="whitespace-pre-wrap rounded border border-edge bg-base p-2 text-xs leading-relaxed">
            {node.lastAgentMessage}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Training score better than holdout by more than 20% of the training span. */
function overfitting(node: EraNode, tree: EraTree): boolean {
  if (node.score === null || node.holdoutScore === null) return false;
  const scores = tree.nodes.map((n) => n.score).filter((s): s is number => s !== null && Number.isFinite(s));
  const span = Math.max(...scores) - Math.min(...scores);
  if (!Number.isFinite(span) || span === 0) return false;
  const gap = tree.metricGoal === "max" ? node.score - node.holdoutScore : node.holdoutScore - node.score;
  return gap > span * 0.2;
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  const border =
    tone === "danger" ? "border-[var(--danger)]" : tone === "warn" ? "border-[var(--warn,#d29922)]" : "border-edge";
  return (
    <div className={`rounded-md border ${border} px-3 py-2 text-xs leading-relaxed`}>
      <div className="font-medium">{title}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------ 改了什么

function Changes({ runDir, node, parent }: { runDir: string; node: EraNode; parent: EraNode | null }) {
  const [names, setNames] = useState<Awaited<ReturnType<typeof nodeDiffNames>> | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; note?: string } | null>(null);

  useEffect(() => {
    setNames(null);
    setFile(null);
    setDiff(null);
    if (!node.path) return;
    void nodeDiffNames(runDir, parent?.path ?? null, node.path).then(setNames);
  }, [runDir, node.path, parent?.path]);

  const show = useCallback(
    async (rel: string) => {
      setFile(rel);
      setDiff(null);
      if (!node.path || !parent?.path) return;
      const [a, b] = await Promise.all([
        readFileText(`${runDir}/${parent.path}/${rel}`, 512 * 1024).catch(() => null),
        readFileText(`${runDir}/${node.path}/${rel}`, 512 * 1024).catch(() => null),
      ]);
      const text = diffText(a?.text ?? "", b?.text ?? "");
      setDiff({
        text,
        note: text ? undefined : "两边内容相同（可能只是权限或时间戳不同，或者文件太大只比了大小）",
      });
    },
    [node.path, parent?.path, runDir],
  );

  if (!node.path) return <p className="text-xs text-dim">这个节点没有工作目录。</p>;
  if (!names) return <p className="text-xs text-dim">正在比较…</p>;
  if (names.error) return <p className="text-xs text-dim">{names.error}</p>;

  const groups: Array<[string, string[]]> = [
    ["修改", names.changed],
    ["新增", names.added],
    ["删除", names.removed],
  ];
  const total = names.changed.length + names.added.length + names.removed.length;

  return (
    <div className="flex flex-col gap-2">
      {total === 0 ? (
        <Callout tone="warn" title="没有任何文件变化">
          改写 agent 什么都没改，或者改的文件被 .era-fixtures 保护、评测前又被还原了。
        </Callout>
      ) : (
        groups.map(([label, list]) =>
          list.length === 0 ? null : (
            <div key={label}>
              <div className="mb-0.5 text-xs text-dim">
                {label}（{list.length}）
              </div>
              <div className="flex flex-col">
                {list.map((rel) => (
                  <button
                    key={rel}
                    onClick={() => void show(rel)}
                    className={`mono truncate px-1 py-0.5 text-left text-xs hover:bg-base ${
                      file === rel ? "bg-base text-ink" : "text-dim"
                    }`}
                  >
                    {rel}
                  </button>
                ))}
              </div>
            </div>
          ),
        )
      )}
      {names.truncated && <p className="text-xs text-dim">目录太大，只比较了前面的一部分文件。</p>}
      {file && (
        <div className="mt-1">
          {diff === null ? (
            <p className="text-xs text-dim">正在读取…</p>
          ) : diff.text ? (
            <DiffView diff={diff.text} />
          ) : (
            <p className="text-xs text-dim">{diff.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- 评测输出

function EvalOutput({ node, nodeDir }: { node: EraNode; nodeDir: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      {node.evalReason && (
        <Callout tone="danger" title="失败原因">
          {node.evalReason}
        </Callout>
      )}
      <Pre title="stdout（era 取最后一行作为分数）" text={node.stdoutTail} />
      <Pre title="stderr" text={node.stderrTail} />
      <p className="text-xs text-dim">
        这里是 trace 里保存的尾部输出。完整输出在节点目录里
        {nodeDir && (
          <>
            {" "}
            —{" "}
            <button onClick={() => void openPath(nodeDir, false).catch(() => undefined)} className="underline hover:text-ink">
              打开
            </button>
          </>
        )}
        。
      </p>
    </div>
  );
}

function Pre({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-dim">{title}</div>
      <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 text-[10px]">
        {text || "（空）"}
      </pre>
    </div>
  );
}

// --------------------------------------------------------- 指令 / 引擎轨迹

function FileTab({ path, empty }: { path: string | null; empty: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!path) return;
    void readFileText(path, 512 * 1024)
      .then((f) => setText(f.text))
      .catch(() => setText(""));
  }, [path]);
  if (!path) return <p className="text-xs text-dim">{empty}</p>;
  if (text === null) return <p className="text-xs text-dim">读取中…</p>;
  if (!text) return <p className="text-xs text-dim">{empty}</p>;
  return (
    <pre className="whitespace-pre-wrap rounded border border-edge bg-base p-2 text-xs leading-relaxed">{text}</pre>
  );
}

function EngineTrace({ path }: { path: string | null }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    setLines(null);
    if (!path) return;
    void readFileText(path, 2 * 1024 * 1024)
      .then((f) => setLines(f.text.split("\n").filter((l) => l.trim())))
      .catch(() => setLines([]));
  }, [path]);

  if (!path) return <p className="text-xs text-dim">这个节点没有引擎轨迹。</p>;
  if (lines === null) return <p className="text-xs text-dim">读取中…</p>;
  if (lines.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-dim">
        没有 .era/engine-trace.jsonl。改写 agent 的逐步记录只有在 era 以 stdio 方式驱动引擎时才会留下。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((raw, i) => {
        let obj: Record<string, unknown> | null = null;
        try {
          obj = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          obj = null;
        }
        const label = obj ? summariseEngineLine(obj) : raw.slice(0, 160);
        return (
          <div key={i}>
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="mono w-full truncate text-left text-[11px] text-dim hover:text-ink"
            >
              {String(i).padStart(3, " ")} {label}
            </button>
            {open === i && (
              <pre className="mono mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px]">
                {obj ? JSON.stringify(obj, null, 2) : raw}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One line per engine event. The engine's event vocabulary is not fixed here —
 * unknown shapes degrade to their type name rather than being dropped.
 */
function summariseEngineLine(o: Record<string, unknown>): string {
  const type = typeof o.type === "string" ? o.type : typeof o.kind === "string" ? o.kind : "?";
  const tool = o.toolName ?? o.tool_name ?? o.name;
  const text = typeof o.text === "string" ? o.text : undefined;
  if (tool) return `${type} ${String(tool)}`;
  if (text) return `${type} ${text.replace(/\s+/g, " ").slice(0, 120)}`;
  return type;
}
