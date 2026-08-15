import { useCallback, useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import {
  onScheduleError,
  onScheduleStatus,
  scheduleList,
  scheduleRemove,
  scheduleRun,
  scheduleUpsert,
} from "../lib/pi-bridge";
import type { ScheduleTaskInfo, ScheduleTaskResult } from "../types";
import { Section } from "./SettingsPage";
import TaskEditModal from "./TaskEditModal";

const RESULT_LABEL: Record<ScheduleTaskResult, string> = {
  ok: "正常",
  alerted: "已告警",
  error: "错误",
};

const RESULT_COLOR: Record<ScheduleTaskResult, string> = {
  ok: "text-[var(--ok)]",
  alerted: "text-[var(--warn,#d29922)]",
  error: "text-[var(--danger)]",
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ISO timestamp -> local "YYYY-MM-DD HH:mm"; empty/invalid input as-is. */
function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Scheduler tab: the task table lives in the gateway sidecar; this panel
 * issues schedule_* commands and renders `schedule-status` snapshots.
 */
export default function TasksSettings() {
  const [tasks, setTasks] = useState<ScheduleTaskInfo[] | null>(null);
  /** undefined = closed, null = creating, info = editing. */
  const [editing, setEditing] = useState<ScheduleTaskInfo | null | undefined>(undefined);

  useEffect(() => {
    scheduleList()
      .then(setTasks)
      .catch((err) => chatStore.pushToast(`加载任务失败：${errText(err)}`, "error"));
    const unStatus = onScheduleStatus(setTasks);
    const unError = onScheduleError((msg) => chatStore.pushToast(msg, "error"));
    return () => {
      void unStatus.then((f) => f());
      void unError.then((f) => f());
    };
  }, []);

  const toggle = useCallback(async (t: ScheduleTaskInfo) => {
    try {
      await scheduleUpsert({ ...t, enabled: !t.enabled });
    } catch (err) {
      chatStore.pushToast(`更新任务失败：${errText(err)}`, "error");
    }
  }, []);

  const runNow = useCallback(async (t: ScheduleTaskInfo) => {
    try {
      await scheduleRun(t.id);
      chatStore.pushToast(`已触发「${t.name}」，结果稍后刷新`, "info");
    } catch (err) {
      chatStore.pushToast(`触发失败：${errText(err)}`, "error");
    }
  }, []);

  const remove = useCallback(async (t: ScheduleTaskInfo) => {
    if (!window.confirm(`确定删除任务「${t.name}」？该操作不可恢复。`)) return;
    try {
      await scheduleRemove(t.id);
      chatStore.pushToast(`已删除 ${t.name}`, "info");
    } catch (err) {
      chatStore.pushToast(`删除失败：${errText(err)}`, "error");
    }
  }, []);

  return (
    <Section title="定时任务">
      {tasks === null ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : tasks.length === 0 ? (
        <p className="mb-2 text-xs text-dim">
          暂无定时任务。watch 型任务在本地定时执行脚本、输出非空时推送告警（零 token）；
          agent 型任务定时唤起一个无头 LLM 会话。点击下方"新建任务"开始。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-md border border-edge bg-base px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{t.name}</span>
                  <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">
                    {t.kind}
                  </span>
                  {t.lastResult && (
                    <span className={`shrink-0 text-[10px] ${RESULT_COLOR[t.lastResult]}`}>
                      {RESULT_LABEL[t.lastResult]}
                    </span>
                  )}
                </div>
                <div className="mono truncate text-xs text-dim">
                  {t.schedule} · 下次 {t.enabled ? fmtTime(t.nextRunAt) : "已停用"} · 上次 {fmtTime(t.lastRun)}
                </div>
                <div className="mono truncate text-[10px] text-dim" title={t.cwd}>
                  {t.cwd}
                </div>
              </div>
              <button
                onClick={() => void toggle(t)}
                title={t.enabled ? "点击停用" : "点击启用"}
                className={`shrink-0 rounded-md border px-2 py-1 text-xs ${
                  t.enabled ? "border-dim text-ink" : "border-edge text-dim"
                } hover:text-ink`}
              >
                {t.enabled ? "启用中" : "已停用"}
              </button>
              <button
                onClick={() => void runNow(t)}
                title="立即运行一次（无视开关与冷却）"
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
              >
                立即运行
              </button>
              <button
                onClick={() => setEditing(t)}
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
              >
                编辑
              </button>
              <button
                onClick={() => void remove(t)}
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setEditing(null)}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
        新建任务
      </button>

      <p className="mt-3 text-xs leading-relaxed text-dim">
        任务由网关子进程按本地时区调度，定义保存在{" "}
        <code className="md-inline-code">~/.kalo/agent/schedules.json</code>
        ；告警与 agent 运行结果通过飞书推送（需先在「IM 网关」扫码连接）。
      </p>

      {editing !== undefined && (
        <TaskEditModal
          task={editing ?? undefined}
          onClose={() => setEditing(undefined)}
        />
      )}
    </Section>
  );
}
