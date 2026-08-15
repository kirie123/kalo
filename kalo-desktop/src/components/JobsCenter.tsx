import { useCallback, useEffect, useRef, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { jobsList, scheduleRun } from "../lib/pi-bridge";
import type { JobsSnapshot } from "../types";

/**
 * Job center (P1-B): top-bar panel unifying running engine sessions
 * (desktop + gateway-sourced) with the gateway's scheduled-task table,
 * including one-click rerun for failed tasks.
 */
export default function JobsCenter() {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<JobsSnapshot | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    jobsList()
      .then(setSnap)
      .catch(() => {
        // Backend unavailable (dev without Rust side) — keep the last state.
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    const timer = window.setInterval(refresh, 5000);
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [open, refresh]);

  const failedTasks = (snap?.tasks ?? []).filter((t) => t.lastResult === "error");
  const badge = (snap?.running.length ?? 0) + failedTasks.length;
  const gatewayRunning = (snap?.running ?? []).filter((s) => s.source === "gateway").length;

  const rerun = useCallback(async (id: string, name: string) => {
    try {
      await scheduleRun(id);
      chatStore.pushToast(`已重跑「${name}」`, "info");
      refresh();
    } catch (err) {
      chatStore.pushToast(`重跑失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [refresh]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="任务中心：运行中的会话与定时任务"
        className={`relative rounded-md p-1.5 hover:bg-card ${open ? "text-ink" : "text-dim hover:text-ink"}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" strokeLinecap="round" />
          <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {badge > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-[var(--danger)] px-0.5 text-[8px] font-medium text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-40 flex max-h-[70vh] w-96 flex-col overflow-y-auto rounded-lg border border-edge bg-card p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">任务中心</span>
            <span className="text-[10px] text-dim">
              {gatewayRunning > 0 ? `${gatewayRunning} 个定时会话运行中` : "无定时会话"}
            </span>
          </div>

          <div className="mb-1 text-[10px] uppercase tracking-wider text-dim">运行中</div>
          {(snap?.running ?? []).length === 0 ? (
            <p className="mb-2 text-xs text-dim">没有运行中的会话。</p>
          ) : (
            <div className="mb-2 flex flex-col gap-1">
              {(snap?.running ?? []).map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-md border border-edge bg-base px-2.5 py-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)]" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs">
                      {s.source === "gateway" ? "定时" : "桌面"} · {s.id.slice(0, 8)}
                    </div>
                    <div className="mono truncate text-[10px] text-dim" title={s.cwd}>
                      {s.cwd}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mb-1 text-[10px] uppercase tracking-wider text-dim">定时任务</div>
          {(snap?.tasks ?? []).length === 0 ? (
            <p className="text-xs text-dim">
              暂无定时任务（设置 → 任务 中创建）。
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {(snap?.tasks ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded-md border border-edge bg-base px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs">{t.name}</span>
                      <span className="shrink-0 rounded border border-edge px-1 text-[9px] text-dim">{t.kind}</span>
                      {t.lastResult === "error" ? (
                        <span className="shrink-0 text-[9px] text-[var(--danger)]">失败</span>
                      ) : t.lastResult === "alerted" ? (
                        <span className="shrink-0 text-[9px] text-[var(--warn,#d29922)]">告警</span>
                      ) : t.lastResult === "ok" ? (
                        <span className="shrink-0 text-[9px] text-[var(--ok)]">正常</span>
                      ) : null}
                      {!t.enabled && <span className="shrink-0 text-[9px] text-dim">已停用</span>}
                    </div>
                    <div className="mono truncate text-[10px] text-dim">
                      {t.enabled ? `下次 ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—"}` : "已停用"}
                    </div>
                  </div>
                  <button
                    onClick={() => void rerun(t.id, t.name)}
                    className="shrink-0 rounded border border-edge px-2 py-0.5 text-[10px] text-dim hover:bg-card hover:text-ink"
                  >
                    {t.lastResult === "error" ? "重跑" : "立即运行"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
