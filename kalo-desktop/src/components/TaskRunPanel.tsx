/**
 * Right-hand run-status column of the automation page
 * (doc/2026-08-29-automation-run-panel.md).
 *
 * Read-only aggregation of two existing sources: the scheduler snapshot
 * (schedule_list + schedule-status events) and jobs_list (running sessions).
 * All derivation lives in lib/task-run-view.ts; this file only renders.
 */

import { useCallback, useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { jobsList, onScheduleStatus, scheduleList, scheduleRun } from "../lib/pi-bridge";
import {
  dotClass,
  fmtTime,
  gatewaySessions,
  runRows,
  toneClass,
} from "../lib/task-run-view";
import type { RunningJobSession, ScheduleTaskInfo } from "../types";
import ContextMenu, { useContextMenu } from "./ContextMenu";

/** jobs_list poll cadence; the task table itself is pushed via events. */
const POLL_MS = 10_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function TaskRunPanel() {
  const [tasks, setTasks] = useState<ScheduleTaskInfo[]>([]);
  const [sessions, setSessions] = useState<RunningJobSession[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const menu = useContextMenu();
  const [menuFor, setMenuFor] = useState<ScheduleTaskInfo | null>(null);

  useEffect(() => {
    scheduleList()
      .then(setTasks)
      .catch((err) => chatStore.pushToast(`加载任务状态失败：${errText(err)}`, "error"));
    const un = onScheduleStatus(setTasks);
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const pollSessions = useCallback(() => {
    // jobs_list fails while the gateway is down; that is ordinary here.
    jobsList()
      .then((snap) => setSessions(snap.running))
      .catch(() => {});
  }, []);

  useEffect(() => {
    pollSessions();
    const timer = setInterval(pollSessions, POLL_MS);
    return () => clearInterval(timer);
  }, [pollSessions]);

  const rows = runRows(tasks);
  const live = gatewaySessions(sessions);
  const runningCount = rows.filter((r) => r.task.running).length;

  return (
    <div className="flex flex-col gap-3 px-4 py-6">
      <div className="text-xs font-medium">运行状态</div>

      <div className="rounded-md border border-edge bg-base px-3 py-2">
        <div className="text-xs text-dim">
          进行中：{runningCount} 个任务{live.length > 0 ? ` · ${live.length} 个定时会话` : ""}
        </div>
        {live.map((s) => (
          <div key={s.id} className="mt-1.5 flex items-center gap-1.5 text-[11px]">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)]" />
            <span className="min-w-0 flex-1 truncate" title={s.cwd}>
              {s.name}
              {s.expertId ? ` · 专家 ${s.expertId}` : ""}
            </span>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-dim">暂无任务。</p>
      ) : (
        rows.map((row) => (
          <div
            key={row.task.id}
            className={`rounded-md border border-edge bg-base px-3 py-2 ${
              row.task.lastOutput ? "cursor-pointer hover:border-dim" : ""
            }`}
            onClick={() =>
              row.task.lastOutput && setExpanded(expanded === row.task.id ? null : row.task.id)
            }
            onContextMenu={(e) => {
              menu.onContextMenu(e);
              setMenuFor(row.task);
            }}
            title={row.task.lastOutput ? "点击展开/收起最近输出" : undefined}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(row.tone)} ${
                  row.status === "running" ? "animate-pulse" : ""
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-xs">{row.task.name}</span>
              <span className={`shrink-0 text-[10px] ${toneClass(row.tone)}`}>{row.statusLabel}</span>
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-dim">{row.hint}</div>
            <div className="mt-0.5 text-[10px] text-dim">
              上次 {fmtTime(row.task.lastRun)} · 下次 {row.task.enabled ? fmtTime(row.task.nextRunAt) : "已停用"}
            </div>
            {row.task.lastOutput && (
              <div className="mt-1 text-[10px] text-dim">
                {expanded === row.task.id ? "收起输出 ▴" : "最近输出 ▾"}
              </div>
            )}
            {expanded === row.task.id && row.task.lastOutput && (
              <pre className="mono mt-1 max-h-48 overflow-y-auto rounded border border-edge bg-card p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                {row.task.lastOutput}
              </pre>
            )}
          </div>
        ))
      )}

      {menu.at && menuFor && (
        <ContextMenu
          at={menu.at}
          onClose={() => {
            menu.close();
            setMenuFor(null);
          }}
          items={[
            ...(menuFor.lastOutput
              ? [{ label: "查看最近输出", action: () => setExpanded(menuFor.id) }]
              : []),
            {
              label: "立即运行一次",
              action: () => {
                scheduleRun(menuFor.id)
                  .then(() => chatStore.pushToast(`已触发「${menuFor.name}」`, "info"))
                  .catch((err) => chatStore.pushToast(`触发失败：${errText(err)}`, "error"));
              },
            },
          ]}
        />
      )}
    </div>
  );
}
