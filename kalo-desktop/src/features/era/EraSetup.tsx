/**
 * The environment card: what kalo will actually run, and how to fix it.
 *
 * This exists because the failure it replaces was invisible. Without it, a
 * machine that has no era — or has one but a Python 2 on PATH — produced a run
 * that "completed" in 1.5 seconds with zero nodes, and the panel could only
 * guess afterwards from an empty trace. Everything shown here is something the
 * resolver actually executed, not something inferred from a path.
 */

import { useCallback, useEffect, useState } from "react";
import { installEra } from "./install";
import {
  formatPython,
  invalidate,
  loadEraBin,
  loadEraSource,
  loadPythonOverride,
  resolveEra,
  saveEraBin,
  saveEraSource,
  savePythonOverride,
  usablePythons,
  type EraResolution,
} from "./locate";

const VIA_LABEL: Record<string, string> = {
  setting: "设置里指定",
  spec: "era-run.json 里的 eraBin",
  path: "PATH",
  uv: "uv 安装",
  source: "源码检出",
};

export default function EraSetup({ onChange }: { onChange?: () => void }) {
  const [res, setRes] = useState<EraResolution | null>(null);
  const [busy, setBusy] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const [mirror, setMirror] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(
    async (force = false) => {
      setBusy(true);
      try {
        if (force) invalidate();
        setRes(await resolveEra(null, force));
      } finally {
        setBusy(false);
        onChange?.();
      }
    },
    [onChange],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const install = useCallback(async () => {
    setInstalling(true);
    setLog("");
    try {
      const r = await installEra({ mirror }, setLog);
      if (r.ok) await refresh(true);
    } catch (e) {
      setLog((l) => `${l}\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }, [mirror, refresh]);

  const pythons = res ? usablePythons(res.probe) : [];
  const ok = res?.ok === true;

  return (
    <div className={`rounded-lg border bg-card p-3 ${ok ? "border-edge" : "border-[var(--warn,#d29922)]"}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">运行环境</span>
        {busy && <span className="text-xs text-dim">正在探测…</span>}
        <button
          onClick={() => void refresh(true)}
          disabled={busy || installing}
          className="ml-auto text-xs text-dim hover:text-ink disabled:opacity-40"
        >
          重新探测
        </button>
      </div>

      {res && ok && (
        <dl className="mono mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-dim">
          <dt>era</dt>
          <dd className="min-w-0 break-all text-ink">
            {res.location.detail}
            <span className="ml-2 text-dim">（{VIA_LABEL[res.location.via] ?? res.location.via}）</span>
          </dd>
          <dt>评测用</dt>
          <dd className="min-w-0 break-all">
            {res.location.python ?? (
              <span className="text-[var(--warn,#d29922)]">没有 ≥3.10 的 Python，评测会用 PATH 上的那个</span>
            )}
          </dd>
        </dl>
      )}

      {res && !ok && (
        <>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            {res.reason}。era 是一个独立的 Python 程序（
            <a
              className="underline hover:text-ink"
              href="https://github.com/kirie123/era-evolve"
              target="_blank"
              rel="noreferrer"
            >
              era-evolve
            </a>
            ），不随 kalo 一起打包。下面这个按钮用 uv 装它——uv 会连同一个自带的 Python 一起下载，
            所以这台机器上有没有 Python、是哪个版本，都不影响。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void install()}
              disabled={installing}
              className="rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-base disabled:opacity-50"
            >
              {installing ? "正在安装…" : "安装 era"}
            </button>
            <input
              value={mirror}
              onChange={(e) => setMirror(e.target.value)}
              placeholder="镜像地址（可选，如 https://pypi.tuna.tsinghua.edu.cn/simple）"
              className="mono min-w-0 flex-1 rounded-md border border-edge bg-base px-2 py-1.5 text-xs"
            />
          </div>
        </>
      )}

      {log && (
        <pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px] text-dim">
          {log}
        </pre>
      )}

      <button onClick={() => setOpen((v) => !v)} className="mono mt-2 text-[11px] text-dim hover:text-ink">
        {open ? "▾" : "▸"} 手动指定 / 探测结果
      </button>

      {open && res && (
        <div className="mt-2 flex flex-col gap-2 border-t border-edge pt-2">
          <Field
            label="era 命令"
            placeholder="留空则自动查找"
            initial={loadEraBin()}
            onSave={(v) => {
              saveEraBin(v);
              void refresh(true);
            }}
          />
          <Field
            label="era 源码目录"
            placeholder="era-evolve 仓库的检出路径（开发 era 本身时用）"
            initial={loadEraSource()}
            onSave={(v) => {
              saveEraSource(v);
              void refresh(true);
            }}
          />
          <Field
            label="Python"
            placeholder="留空则用探测到的最高版本"
            initial={loadPythonOverride()}
            onSave={(v) => {
              savePythonOverride(v);
              void refresh(true);
            }}
          />

          <div className="text-[11px] text-dim">
            <div className="mb-0.5">探测到的解释器：</div>
            {res.probe.pythons.length === 0 ? (
              <div className="mono">（一个都没有）</div>
            ) : (
              <ul className="mono flex flex-col gap-0.5">
                {res.probe.pythons.map((p) => {
                  const usable = pythons.some((u) => u.path === p.path);
                  return (
                    <li key={p.path} className={usable ? "text-ink" : "line-through opacity-60"}>
                      {formatPython(p)} · <span className="break-all">{p.path}</span>
                      {!usable && <span className="ml-1 no-underline">（era 要 ≥3.10 的正式版）</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {res.probe.sources.length > 0 && (
            <div className="mono text-[11px] text-dim">
              源码检出：{res.probe.sources.join(" / ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  placeholder,
  initial,
  onSave,
}: {
  label: string;
  placeholder: string;
  initial: string;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-dim">{label}</span>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() !== initial.trim() && onSave(v)}
        placeholder={placeholder}
        className="mono min-w-0 flex-1 rounded-md border border-edge bg-base px-2 py-1 text-xs"
      />
    </label>
  );
}
