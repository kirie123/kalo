/**
 * The verification gate — the screen between "a spec exists" and "money is
 * being spent".
 *
 * It runs the eval on an untouched copy of the seed, exactly as era would,
 * and shows the baseline number next to six mechanical checks. The user's job
 * here is one glance: *is that number what I think it is?* No amount of
 * downstream visualisation can answer that question later.
 */

import { useCallback, useEffect, useState } from "react";
import { listDir, openPath, readFileText } from "../../lib/pi-bridge";
import { runGateChecks, scriptsInCommand, type CheckStatus, type GateResult } from "./gate";
import { runEvalProbe, type ProbeResult } from "./probe";
import { readFixtures } from "./runs";
import type { EraRunSpec } from "./spec";

const STATUS_MARK: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  unknown: "?",
};

const STATUS_COLOR: Record<CheckStatus, string> = {
  pass: "text-[var(--ok)]",
  warn: "text-[var(--warn,#d29922)]",
  fail: "text-[var(--danger)]",
  unknown: "text-dim",
};

interface EraGateProps {
  workspace: string;
  spec: EraRunSpec;
  /** Absolute seed path, already resolved against the workspace. */
  seedDir: string;
  /** [开始演化] — only reachable when the score parses. */
  onStart: () => void;
  /** [让它改改] — hand the problem back to a kalo session. */
  onAskAgent: (complaint: string) => void;
  onCancel: () => void;
}

export default function EraGate({ workspace, spec, seedDir, onStart, onAskAgent, onCancel }: EraGateProps) {
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [gate, setGate] = useState<GateResult | null>(null);
  const [evalSource, setEvalSource] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  /** Leftover `.era` in the seed: another run's bookkeeping, copied into every node. */
  const [staleEra, setStaleEra] = useState(false);
  /** The single explicit escape hatch, for evals too slow to run here. */
  const [skipping, setSkipping] = useState(false);
  const [skipAcknowledged, setSkipAcknowledged] = useState(false);

  useEffect(() => {
    void listDir(seedDir)
      .then((entries) => setStaleEra(entries.some((e) => e.isDir && e.name === ".era")))
      .catch(() => setStaleEra(false));
  }, [seedDir]);

  const verify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runEvalProbe({
        workDir: workspace,
        seedDir,
        evalCmd: spec.evalCmd,
        twice: true,
        // Generous: the point is to observe the real duration, not to enforce.
        timeoutS: Math.max(60, spec.evalTimeout * 2),
      });
      const fixtures = await readFixtures(seedDir);
      setProbe(result);
      setGate(
        runGateChecks({
          spec,
          first: result.first,
          second: result.second,
          fixtures: fixtures.entries,
          fixturesPresent: fixtures.present,
        }),
      );
      // Show the scorer itself: the number means nothing without it.
      const candidate = scriptsInCommand(spec.evalCmd)[0];
      if (candidate) {
        const file = await readFileText(`${seedDir}/${candidate}`, 64 * 1024).catch(() => null);
        setEvalSource(file ? { path: candidate, text: file.text } : null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [seedDir, spec, workspace]);

  const complaint = () => {
    if (!gate) return "评测跑不起来，帮我看看。";
    const bad = gate.checks.filter((c) => c.status === "fail" || c.status === "warn");
    return [
      `我在 ${workspace} 验证评测，结果不对：`,
      `基线分数：${gate.baseline === null ? "解析不出来" : String(gate.baseline)}`,
      ...bad.map((c) => `- ${c.label}：${c.detail}`),
      probe?.first.stderr ? `\nstderr:\n${probe.first.stderr.slice(-1500)}` : "",
      "\n请改 seed 里的评测脚本或 era-run.json，改完告诉我。",
    ].join("\n");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge bg-card p-3">
        <div className="text-sm font-medium">开始前先验一次评测</div>
        <p className="mt-1 text-xs leading-relaxed text-dim">
          era 会朝着这个分数爬 {spec.budget} 次。分数如果量错了东西，整轮演化就是在优化一个 bug，
          而且过程中分数一路上涨、看不出异常。所以这一步不能跳过：下面的数字是在<b>未改动的 seed</b> 上
          用和 era 完全相同的方式跑出来的。
        </p>
        <dl className="mono mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-dim">
          <dt>任务</dt>
          <dd className="text-ink">{spec.task}</dd>
          <dt>seed</dt>
          <dd className="truncate">{seedDir}</dd>
          <dt>评测</dt>
          <dd>{spec.evalCmd}</dd>
          <dt>方向</dt>
          <dd>{spec.metricGoal === "max" ? "越大越好" : "越小越好"}</dd>
          {spec.scoreMeaning && (
            <>
              <dt>分数含义</dt>
              <dd className="text-ink">{spec.scoreMeaning}</dd>
            </>
          )}
        </dl>
      </div>

      {staleEra && (
        <div className="rounded-md border border-[var(--danger)] px-3 py-2 text-xs leading-relaxed">
          seed 目录里有一个 <code className="md-inline-code">.era</code> —— 那是别的一次运行留下的记录。
          它会被复制进每一个节点，把日志和真正的运行混在一起。删掉它再开始。
        </div>
      )}

      {!gate && !skipping && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => void verify()}
            disabled={busy}
            className="rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-card disabled:opacity-50"
          >
            {busy ? "正在跑两次评测…" : "跑一次验证"}
          </button>
          <button onClick={() => setSkipping(true)} className="text-xs text-dim hover:text-ink">
            评测太慢，跳过验证
          </button>
          <button onClick={onCancel} className="ml-auto text-sm text-dim hover:text-ink">
            返回
          </button>
        </div>
      )}

      {!gate && skipping && (
        <div className="rounded-md border border-[var(--warn,#d29922)] px-3 py-2 text-xs leading-relaxed">
          <div>
            跳过意味着没有人确认过这个分数量的是不是你要的东西。era 会朝它爬 {spec.budget} 次，
            期间不会有任何东西提醒你量错了。
          </div>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={skipAcknowledged}
              onChange={(e) => setSkipAcknowledged(e.target.checked)}
            />
            我知道这次没有验证过评测
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={onStart}
              disabled={!skipAcknowledged}
              className="rounded-md border border-dim px-3 py-1 text-xs text-ink hover:bg-card disabled:opacity-40"
            >
              直接开始
            </button>
            <button onClick={() => setSkipping(false)} className="text-xs text-dim hover:text-ink">
              还是验一下
            </button>
          </div>
        </div>
      )}

      {error && <div className="rounded-md border border-[var(--danger)] px-3 py-2 text-xs">{error}</div>}

      {gate && (
        <>
          {probe?.pythonNote && (
            <div
              className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${
                probe.pythonWarning ? "border-[var(--warn,#d29922)]" : "border-edge text-dim"
              }`}
            >
              {probe.pythonNote}
              {probe.effectiveEvalCmd !== spec.evalCmd && (
                <div className="mono mt-1 break-all text-[10px] text-dim">{probe.effectiveEvalCmd}</div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-edge bg-card p-3">
            <div className="text-xs text-dim">基线分数（seed 未改动）</div>
            <div className="mono mt-0.5 text-2xl">
              {gate.baseline === null ? <span className="text-[var(--danger)]">解析失败</span> : gate.baseline}
            </div>
            {probe && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-dim hover:text-ink">评测原始输出</summary>
                <pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px] text-dim">
                  {probe.first.stdout || "（stdout 为空）"}
                  {probe.first.stderr ? `\n--- stderr ---\n${probe.first.stderr}` : ""}
                </pre>
                <button
                  onClick={() => void openPath(probe.probeDir, true).catch(() => undefined)}
                  className="mt-1 text-[10px] text-dim underline hover:text-ink"
                >
                  打开验证目录
                </button>
              </details>
            )}
          </div>

          <div className="rounded-lg border border-edge bg-card p-3">
            <div className="mb-2 text-sm font-medium">核对</div>
            <div className="flex flex-col gap-1.5">
              {gate.checks.map((c) => (
                <div key={c.id} className="flex gap-2 text-xs">
                  <span className={`mono w-3 shrink-0 ${STATUS_COLOR[c.status]}`}>{STATUS_MARK[c.status]}</span>
                  <div className="min-w-0 flex-1">
                    <span>{c.label}</span>
                    <span className="mono ml-2 text-dim">{c.detail}</span>
                    {c.hint && <div className="mt-0.5 leading-relaxed text-dim">{c.hint}</div>}
                  </div>
                </div>
              ))}
            </div>
            {gate.notes.map((n, i) => (
              <p key={i} className="mt-2 text-xs leading-relaxed text-dim">
                {n}
              </p>
            ))}
          </div>

          {evalSource && (
            <div className="rounded-lg border border-edge bg-card p-3">
              <button
                onClick={() => setShowSource((v) => !v)}
                className="mono text-xs text-dim hover:text-ink"
              >
                {showSource ? "▾" : "▸"} {evalSource.path} —— 这个文件定义了分数
              </button>
              {showSource && (
                <pre className="mono mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px]">
                  {evalSource.text}
                </pre>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={onStart}
              disabled={!gate.canStart}
              title={gate.canStart ? undefined : "分数解析不出来，跑了也是白跑"}
              className="rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-card disabled:opacity-40"
            >
              开始演化
            </button>
            <button
              onClick={() => onAskAgent(complaint())}
              className="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
            >
              让它改改
            </button>
            <button
              onClick={() => void openPath(seedDir, false).catch(() => undefined)}
              className="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
            >
              我自己改
            </button>
            <button
              onClick={() => void verify()}
              disabled={busy}
              className="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-50"
            >
              重新验证
            </button>
            <button onClick={onCancel} className="ml-auto text-sm text-dim hover:text-ink">
              返回
            </button>
          </div>
        </>
      )}
    </div>
  );
}
