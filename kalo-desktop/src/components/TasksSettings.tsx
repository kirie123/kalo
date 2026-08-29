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
import { describeCron } from "../lib/schedule-spec";
import { fmtTime } from "../lib/task-run-view";
import type { ScheduleTaskInfo, ScheduleTaskResult } from "../types";
import ContextMenu, { useContextMenu } from "./ContextMenu";
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

/**
 * Scheduler tab: the task table lives in the gateway sidecar; this panel
 * issues schedule_* commands and renders `schedule-status` snapshots.
 */
export default function TasksSettings() {
  const [tasks, setTasks] = useState<ScheduleTaskInfo[] | null>(null);
  /** undefined = closed, null = creating, info = editing. */
  const [editing, setEditing] = useState<ScheduleTaskInfo | null | undefined>(undefined);
  /** Task id whose lastOutput is expanded inline. */
  const [expandedOutput, setExpandedOutput] = useState<string | null>(null);
  /** Right-click menu on a task row; `menuFor` remembers which task it targets. */
  const menu = useContextMenu();
  const [menuFor, setMenuFor] = useState<ScheduleTaskInfo | null>(null);

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
            <div
              key={t.id}
              className="rounded-md border border-edge bg-base px-3 py-2"
              onContextMenu={(e) => {
                menu.onContextMenu(e);
                setMenuFor(t);
              }}
            >              <div className="flex items-center gap-2">
              <div
                className={`min-w-0 flex-1 ${t.lastOutput ? "cursor-pointer" : ""}`}
                onClick={() => t.lastOutput && setExpandedOutput(expandedOutput === t.id ? null : t.id)}
                title={t.lastOutput ? "点击展开/收起最近一次输出" : undefined}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{t.name}</span>
                  <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">
                    {t.kind}
                  </span>
                  {t.running && (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--ok)]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                      运行中
                    </span>
                  )}
                  {!t.running && t.lastResult && (
                    <span className={`shrink-0 text-[10px] ${RESULT_COLOR[t.lastResult]}`}>
                      {RESULT_LABEL[t.lastResult]}
                    </span>
                  )}
                  {t.lastOutput && (
                    <span className="shrink-0 text-[10px] text-dim">
                      {expandedOutput === t.id ? "▴" : "▾"}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-dim" title={t.schedule}>
                  {describeCron(t.schedule)} · 下次 {t.enabled ? fmtTime(t.nextRunAt) : "已停用"} · 上次{" "}
                  {fmtTime(t.lastRun)}
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
              {expandedOutput === t.id && t.lastOutput && (
                <pre className="mono mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-edge bg-card p-2 text-[10px] leading-relaxed text-dim">
                  {t.lastOutput}
                </pre>
              )}
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

      {menu.at && menuFor && (
        <ContextMenu
          at={menu.at}
          onClose={() => {
            menu.close();
            setMenuFor(null);
          }}
          items={[
            ...(menuFor.lastOutput
              ? [
                  {
                    label: "查看最近输出",
                    action: () => setExpandedOutput(menuFor.id),
                  },
                ]
              : []),
            { label: "立即运行一次", action: () => void runNow(menuFor) },
            {
              label: menuFor.enabled ? "停用" : "启用",
              action: () => void toggle(menuFor),
            },
            { label: "编辑", action: () => setEditing(menuFor) },
            { label: "删除", action: () => void remove(menuFor), danger: true },
          ]}
        />
      )}
    </Section>
  );
}
