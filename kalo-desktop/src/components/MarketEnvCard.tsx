/**
 * 市场数据运行环境 — the card that makes "装完即可用" true, or says why it isn't.
 *
 * The four market skills (`market-data` / `macro-pulse` / `filing-digest` /
 * `stock-checkup`) install themselves as plain files, so on a fresh machine the
 * *instructions* are always there. What cannot ship with them is a Python that
 * can `import akshare` — ~178 MB of wheels for a machine we know nothing about.
 * So this card exists to cover exactly one gap: interpreter + dependencies.
 *
 * Everything shown here comes from **executing** `~/.kalo/market/py` (the shim
 * `market_env.rs` writes), not from inspecting paths. That matters because it is
 * the same shim the daily snapshot task runs — if this card says ready, the
 * 17:12 weekday `macro append` will work, and if it says otherwise the two
 * cannot disagree.
 *
 * The install itself is an ordinary background job, same as `era/install.ts`:
 * `jobStart` runs `setup.sh`, `readTextSince` tails its log, `== 完成` is the
 * success marker the script and this file agree on. No new process management.
 */

import { useCallback, useEffect, useState } from "react";
import { appPaths, jobList, jobStart, marketEnvStatus, readTextSince } from "../lib/pi-bridge";
import { isJobTerminal, type MarketEnv } from "../types";
import { shq } from "../features/era/spec";

const ROUTE_LABEL: Record<string, string> = {
  override: "KALO_MARKET_PYTHON 指定",
  venv: "专用 venv",
  uv: "uv 管理的 Python",
  system: "系统 Python",
  none: "没找到",
};

/** What each dependency is for, so "缺 pypdf" is actionable rather than cryptic. */
const DEP_NOTE: Record<string, string> = {
  requests: "抓网页与接口",
  yaml: "读 sources.yaml",
  pypdf: "读公告 PDF",
  akshare: "两融余额等 A 股数据",
  pandas: "akshare 依赖",
};

export default function MarketEnvCard() {
  const [env, setEnv] = useState<MarketEnv | null>(null);
  const [busy, setBusy] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const [mirror, setMirror] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setEnv(await marketEnvStatus());
    } catch (err) {
      setEnv(null);
      setLog(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    setInstalling(true);
    setLog("");
    try {
      await runSetup({ mirror }, setLog);
      // Refresh regardless of the verdict: a partial install still changes
      // what the shim resolves to, and the fresh status is more trustworthy
      // than the log's last line.
      await refresh();
    } catch (err) {
      setLog((l) => `${l}\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(false);
    }
  }, [mirror, refresh]);

  const ok = env?.ready === true;
  const deps = env ? Object.entries(env.deps) : [];

  return (
    <div
      className={`mb-3 rounded-lg border bg-card p-3 ${ok ? "border-edge" : "border-[var(--warn,#d29922)]"}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">市场数据运行环境</span>
        {busy ? (
          <span className="text-xs text-dim">正在自检…</span>
        ) : (
          <span className={`text-xs ${ok ? "text-dim" : "text-[var(--warn,#d29922)]"}`}>
            {ok ? "就绪" : "未就绪"}
          </span>
        )}
        <button
          onClick={() => void refresh()}
          disabled={busy || installing}
          className="ml-auto text-xs text-dim hover:text-ink disabled:opacity-40"
        >
          重新自检
        </button>
      </div>

      {env && (
        <dl className="mono mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-dim">
          <dt>解释器</dt>
          <dd className="min-w-0 break-all text-ink">
            {env.python ?? <span className="text-[var(--warn,#d29922)]">没找到可用的 Python（要 ≥3.10 正式版）</span>}
            {env.python && (
              <span className="ml-2 text-dim">
                （{ROUTE_LABEL[env.route] ?? env.route}
                {env.version ? ` · ${env.version}` : ""}）
              </span>
            )}
          </dd>
          <dt>入口</dt>
          <dd className="min-w-0 break-all">
            {env.shim}
            {env.shimState === "userEdited" && <span className="ml-2 text-dim">（你改过，Kalo 不会覆盖）</span>}
          </dd>
        </dl>
      )}

      {env && !ok && (
        <p className="mt-2 text-xs leading-relaxed text-dim">
          <span className="text-ink">四个市场 Skill 本身已经装好了</span>
          （market-data / macro-pulse / filing-digest / stock-checkup），缺的只是跑它们的 Python 环境。
          下面这个按钮建一个专用 venv 并装依赖（akshare 与 pandas 约 178MB，要联网，几分钟）。
          这台机器上没有可用 Python 也没关系，脚本会用 uv 现拉一份。
        </p>
      )}

      {env && !ok && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void install()}
            disabled={installing || busy}
            className="rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-base disabled:opacity-50"
          >
            {installing ? "正在初始化…" : "一键初始化"}
          </button>
          <input
            value={mirror}
            onChange={(e) => setMirror(e.target.value)}
            placeholder="镜像地址（可选，如 https://pypi.tuna.tsinghua.edu.cn/simple）"
            className="mono min-w-0 flex-1 rounded-md border border-edge bg-base px-2 py-1.5 text-xs"
          />
        </div>
      )}

      {env?.error && !installing && (
        <pre className="mono mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px] text-dim">
          {env.error}
        </pre>
      )}

      {log && (
        <pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px] text-dim">
          {log}
        </pre>
      )}

      <button onClick={() => setOpen((v) => !v)} className="mono mt-2 text-[11px] text-dim hover:text-ink">
        {open ? "▾" : "▸"} 依赖与手工命令
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 border-t border-edge pt-2 text-[11px] text-dim">
          {deps.length > 0 && (
            <ul className="mono flex flex-col gap-0.5">
              {deps.map(([name, present]) => (
                <li key={name} className={present ? "text-ink" : "text-[var(--warn,#d29922)]"}>
                  {present ? "✓" : "✗"} {name}
                  <span className="ml-2 text-dim">{DEP_NOTE[name] ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
          {env?.venv && <div className="mono break-all">venv：{env.venv}</div>}
          <div>
            <div className="mb-0.5">终端里也能用同一个入口（不需要先激活 venv）：</div>
            <pre className="mono overflow-auto whitespace-pre-wrap rounded bg-base p-2 text-[10px]">
              {'~/.kalo/market/py ~/.kalo/skills/market-data/md.py doctor\n' +
                'bash ~/.kalo/skills/market-data/setup.sh\n' +
                'export KALO_MARKET_PYTHON=/path/to/python   # 想指定别的解释器'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Run `setup.sh` as a background job and stream its log until it settles.
 *
 * A copy of `installEra`'s loop on purpose — the two scripts install different
 * things but the mechanism (job + tailed log + `== 完成`) is the one already
 * proven here, and sharing it would mean a helper parameterised on nothing but
 * a path and a label.
 */
async function runSetup(
  opts: { mirror?: string },
  onLog: (text: string) => void,
): Promise<{ ok: boolean; log: string }> {
  const paths = await appPaths();
  const script = `${paths.kaloRoot}/skills/market-data/setup.sh`;
  const dir = `${paths.kaloRoot}/market/.setup`;
  const logPath = `${dir}/log`;
  const mirror = opts.mirror?.trim();
  const cmd = [
    `mkdir -p ${shq(dir)}`,
    `: > ${shq(logPath)}`,
    `{`,
    `bash ${shq(script)}${mirror ? ` --mirror ${shq(mirror)}` : ""}`,
    `} >> ${shq(logPath)} 2>&1`,
  ].join("\n");

  const jobId = await jobStart({
    label: "初始化市场数据环境",
    cwd: paths.kaloRoot || paths.home,
    cmd,
    kind: "marketsetup",
  });

  let offset = 0;
  let log = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const slice = await readTextSince(logPath, offset, 128 * 1024).catch(() => null);
    if (slice && slice.text) {
      offset = slice.offset;
      log += slice.text;
      onLog(log);
    }
    const jobs = await jobList().catch(() => []);
    const job = jobs.find((j) => j.id === jobId);
    if (job && isJobTerminal(job.status)) break;
  }
  // One last read: the job can settle between two polls, and the tail is
  // exactly where the reason for a failure is written.
  const tail = await readTextSince(logPath, offset, 128 * 1024).catch(() => null);
  if (tail?.text) {
    log += tail.text;
    onLog(log);
  }
  return { ok: /^== 完成$/m.test(log), log };
}
