/**
 * Run-panel view logic for the automation page (doc/2026-08-29-automation-run-panel.md).
 *
 * Pure functions only: status derivation, copy, ordering. The panel component
 * renders these rows; nothing here touches IPC or the DOM.
 */

import type { RunningJobSession, ScheduleTaskInfo } from "../types";

export type RunTone = "ok" | "warn" | "danger" | "dim";

export interface RunRow {
  task: ScheduleTaskInfo;
  status: "running" | "alerted" | "error" | "ok" | "idle";
  statusLabel: string;
  tone: RunTone;
  /** One line explaining what the status means. */
  hint: string;
}

/** Derive the display status of one task, most informative first. */
export function runRow(task: ScheduleTaskInfo): RunRow {
  if (task.running) {
    return {
      task,
      status: "running",
      statusLabel: "运行中",
      tone: "ok",
      hint: task.kind === "watch" ? "脚本正在执行" : "无头会话正在运行",
    };
  }
  if (!task.lastRun || !task.lastResult) {
    return { task, status: "idle", statusLabel: "未运行", tone: "dim", hint: "还没有运行过" };
  }
  if (task.lastResult === "alerted") {
    return {
      task,
      status: "alerted",
      statusLabel: "已告警",
      tone: "warn",
      hint: "脚本输出了内容，已作为告警推送；正文见下方",
    };
  }
  if (task.lastResult === "error") {
    return {
      task,
      status: "error",
      statusLabel: "错误",
      tone: "danger",
      hint: task.kind === "watch" ? "脚本执行失败或超时" : "会话启动失败或异常退出",
    };
  }
  return {
    task,
    status: "ok",
    statusLabel: "正常",
    tone: "ok",
    hint: task.kind === "watch" ? "脚本静默结束（无告警）" : "会话正常跑完",
  };
}

/**
 * Order for the run panel: in-flight first, then most recently run.
 * Never-run tasks sink to the bottom.
 */
export function runRows(tasks: ScheduleTaskInfo[]): RunRow[] {
  return tasks
    .map(runRow)
    .sort((a, b) => {
      if (a.task.running !== b.task.running) return a.task.running ? -1 : 1;
      const at = a.task.lastRun ?? "";
      const bt = b.task.lastRun ?? "";
      return bt.localeCompare(at);
    });
}

/** Sessions spawned by scheduled tasks (as opposed to desktop chats). */
export function gatewaySessions(sessions: RunningJobSession[]): RunningJobSession[] {
  return sessions.filter((s) => s.source === "gateway");
}

const TONE_CLASS: Record<RunTone, string> = {
  ok: "text-[var(--ok)]",
  warn: "text-[var(--warn,#d29922)]",
  danger: "text-[var(--danger)]",
  dim: "text-dim",
};

export function toneClass(tone: RunTone): string {
  return TONE_CLASS[tone];
}

const DOT_CLASS: Record<RunTone, string> = {
  ok: "bg-[var(--ok)]",
  warn: "bg-[var(--warn,#d29922)]",
  danger: "bg-[var(--danger)]",
  dim: "bg-edge",
};

export function dotClass(tone: RunTone): string {
  return DOT_CLASS[tone];
}

/** ISO timestamp -> local "YYYY-MM-DD HH:mm"; empty/invalid input as-is. */
export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
