import { useState } from "react";
import { chatStore } from "../lib/chat-store";
import { scheduleUpsert } from "../lib/pi-bridge";
import {
  buildCron,
  defaultSpec,
  describeCron,
  parseSpec,
  validateSpec,
  WEEKDAY_LABELS,
  type ScheduleFreq,
  type ScheduleSpec,
} from "../lib/schedule-spec";
import type { ScheduleTask, ScheduleTaskInfo, ScheduleTaskKind } from "../types";

interface Props {
  /** Given when editing an existing task; undefined for "new task". */
  task?: ScheduleTaskInfo;
  onClose: (saved: boolean) => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const KIND_LABEL: Record<ScheduleTaskKind, string> = {
  watch: "watch（脚本告警）",
  agent: "agent（LLM 会话）",
};

const KIND_HINT: Record<ScheduleTaskKind, string> = {
  watch: "本地执行下面的 bash 脚本，标准输出非空时推送告警，零 token。",
  agent: "到点唤起一个无头 LLM 会话执行下面的 Prompt。",
};

const FREQ_LABEL: Record<ScheduleFreq, string> = {
  daily: "每天",
  weekdays: "工作日",
  weekly: "每周",
  monthly: "每月",
  hourly: "每小时",
  minutes: "每隔几分钟",
  custom: "自定义",
};

const FREQ_ORDER: ScheduleFreq[] = ["daily", "weekdays", "weekly", "monthly", "hourly", "minutes", "custom"];

/** 每隔 N 分钟的可选间隔。给固定档位而不是任意数字输入：
 *  这类任务的间隔本来就只有这几种合理取值，选比填快。 */
const MINUTE_STEPS = [5, 10, 15, 20, 30];

/** 这几种频率要挑一个具体时刻；hourly / minutes / custom 不需要。 */
const TIMED_FREQS: ScheduleFreq[] = ["daily", "weekdays", "weekly", "monthly"];

const pad = (n: number) => String(n).padStart(2, "0");

function clamp(raw: string, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** Create/edit form for one scheduled task, saved via schedule_upsert. */
export default function TaskEditModal({ task, onClose }: Props) {
  const [name, setName] = useState(task?.name ?? "");
  const [id, setId] = useState(task?.id ?? "");
  const [kind, setKind] = useState<ScheduleTaskKind>(task?.kind ?? "watch");
  const [schedule, setSchedule] = useState<ScheduleSpec>(() =>
    task?.schedule ? parseSpec(task.schedule) : defaultSpec(),
  );
  const [cwd, setCwd] = useState(task?.cwd ?? "");
  const [script, setScript] = useState(task?.script ?? "");
  const [cooldownMin, setCooldownMin] = useState(task?.cooldownMin != null ? String(task.cooldownMin) : "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [model, setModel] = useState(task?.model ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    const trimmedId = id.trim();
    if (!task && !/^[\w-]{1,64}$/.test(trimmedId)) {
      chatStore.pushToast("ID 只能包含字母、数字、下划线、连字符（1-64 字符）", "warning");
      return;
    }
    if (!name.trim()) {
      chatStore.pushToast("名称不能为空", "warning");
      return;
    }
    const scheduleErr = validateSpec(schedule);
    if (scheduleErr) {
      chatStore.pushToast(scheduleErr, "warning");
      return;
    }
    const trimmedSchedule = buildCron(schedule);
    if (!cwd.trim()) {
      chatStore.pushToast("工作目录不能为空", "warning");
      return;
    }
    if (kind === "watch" && !script.trim()) {
      chatStore.pushToast("watch 任务需要填写脚本", "warning");
      return;
    }
    if (kind === "agent" && !prompt.trim()) {
      chatStore.pushToast("agent 任务需要填写 Prompt", "warning");
      return;
    }
    const cooldown = cooldownMin.trim() ? Number(cooldownMin) : undefined;
    if (cooldown !== undefined && (!Number.isFinite(cooldown) || cooldown < 0)) {
      chatStore.pushToast("冷却分钟数无效", "warning");
      return;
    }

    const next: ScheduleTask = {
      id: task ? task.id : trimmedId,
      name: name.trim(),
      kind,
      schedule: trimmedSchedule,
      cwd: cwd.trim(),
      enabled,
      // Kind-specific fields; stale fields of the other kind are cleared.
      script: kind === "watch" ? script : undefined,
      matchMode: kind === "watch" ? "nonEmpty" : undefined,
      cooldownMin: kind === "watch" ? cooldown : undefined,
      prompt: kind === "agent" ? prompt : undefined,
      model: kind === "agent" ? model.trim() || null : undefined,
      // Run history is preserved across edits.
      lastRun: task?.lastRun,
      lastResult: task?.lastResult,
    };
    setSaving(true);
    try {
      await scheduleUpsert(next);
      chatStore.pushToast("任务已保存", "info");
      onClose(true);
    } catch (err) {
      chatStore.pushToast(`保存失败：${errText(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-edge bg-base px-3 py-1.5 text-sm outline-none focus:border-dim";
  const selectCls = "rounded-md border border-edge bg-base px-2 py-1 text-sm outline-none focus:border-dim";
  const labelCls = "mb-1 mt-3 text-xs text-dim";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => onClose(false)}>
      <div
        className="flex max-h-[85vh] w-[640px] max-w-[92vw] flex-col overflow-y-auto rounded-xl border border-edge bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">{task ? `编辑任务：${task.name}` : "新建任务"}</h3>

        <div className={labelCls}>名称</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：股价异动监控"
          autoFocus={!task}
          className={inputCls}
        />

        <div className={labelCls}>ID{task && "（不可修改）"}</div>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="字母数字与 - _，如 price-watch"
          disabled={Boolean(task)}
          className={`mono ${inputCls} disabled:opacity-40`}
        />

        <div className={labelCls}>类型</div>
        <div className="flex gap-2">
          {(["watch", "agent"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                kind === k ? "border-dim bg-base text-ink" : "border-edge text-dim hover:text-ink"
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-dim">{KIND_HINT[kind]}</p>

        {kind === "watch" ? (
          <>
            <div className={labelCls}>脚本（bash）</div>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={"curl -s ... | grep ...\n# 有输出即告警"}
              spellCheck={false}
              className="mono min-h-[120px] w-full resize-y rounded-md border border-edge bg-base p-3 text-xs leading-relaxed outline-none focus:border-dim"
            />
            <div className={labelCls}>告警冷却（分钟，留空不冷却）</div>
            <input
              type="number"
              min={0}
              value={cooldownMin}
              onChange={(e) => setCooldownMin(e.target.value)}
              placeholder="如 30"
              className={`mono ${inputCls}`}
            />
          </>
        ) : (
          <>
            <div className={labelCls}>Prompt</div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述要让 agent 定时完成的事"
              spellCheck={false}
              className="min-h-[100px] w-full resize-y rounded-md border border-edge bg-base p-3 text-sm leading-relaxed outline-none focus:border-dim"
            />
            <div className={labelCls}>模型</div>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="provider/modelId，留空用默认"
              className={`mono ${inputCls}`}
            />
          </>
        )}

        <div className={labelCls}>运行时间（本地时区）</div>
        <div className="flex flex-wrap gap-1.5">
          {FREQ_ORDER.map((f) => (
            <button
              key={f}
              onClick={() => setSchedule({ ...schedule, freq: f })}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                schedule.freq === f ? "border-dim bg-base text-ink" : "border-edge text-dim hover:text-ink"
              }`}
            >
              {FREQ_LABEL[f]}
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {schedule.freq === "minutes" && (
            <select
              value={schedule.everyMin}
              onChange={(e) => setSchedule({ ...schedule, everyMin: Number(e.target.value) })}
              className={selectCls}
            >
              {MINUTE_STEPS.map((n) => (
                <option key={n} value={n}>
                  每 {n} 分钟
                </option>
              ))}
            </select>
          )}

          {schedule.freq === "hourly" && (
            <>
              <span className="text-xs text-dim">每小时的第</span>
              <input
                type="number"
                min={0}
                max={59}
                value={schedule.minute}
                onChange={(e) => setSchedule({ ...schedule, minute: clamp(e.target.value, 0, 59) })}
                className={`mono w-20 ${selectCls}`}
              />
              <span className="text-xs text-dim">分</span>
            </>
          )}

          {schedule.freq === "monthly" && (
            <>
              <span className="text-xs text-dim">每月</span>
              <input
                type="number"
                min={1}
                max={31}
                value={schedule.dom}
                onChange={(e) => setSchedule({ ...schedule, dom: clamp(e.target.value, 1, 31) })}
                className={`mono w-20 ${selectCls}`}
              />
              <span className="text-xs text-dim">日</span>
            </>
          )}

          {schedule.freq === "weekly" && (
            <div className="flex gap-1">
              {WEEKDAY_LABELS.map((label, d) => {
                const on = schedule.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    title={`周${label}`}
                    onClick={() =>
                      setSchedule({
                        ...schedule,
                        weekdays: on
                          ? schedule.weekdays.filter((x) => x !== d)
                          : [...schedule.weekdays, d].sort((a, b) => a - b),
                      })
                    }
                    className={`h-7 w-7 rounded-md border text-xs ${
                      on ? "border-dim bg-base text-ink" : "border-edge text-dim hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {TIMED_FREQS.includes(schedule.freq) && (
            <input
              type="time"
              value={`${pad(schedule.hour)}:${pad(schedule.minute)}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) setSchedule({ ...schedule, hour: h, minute: m });
              }}
              className={`mono ${selectCls}`}
            />
          )}

          {schedule.freq === "custom" && (
            <input
              value={schedule.cron}
              onChange={(e) => setSchedule({ ...schedule, cron: e.target.value })}
              placeholder="*/10 * * * *"
              className={`mono ${inputCls}`}
            />
          )}
        </div>

        {/* 预览行：把最终存下去的 cron 也露出来。上面的控件已经够用，
            但这一行让"我到底设成了什么"无需重新打开确认。 */}
        <p className="mt-1.5 text-[10px] text-dim">
          {schedule.freq === "custom"
            ? "5 个字段：分 时 日 月 周，如「*/10 * * * *」表示每 10 分钟。"
            : `即 ${describeCron(buildCron(schedule))} 运行 · cron ${buildCron(schedule)}`}
        </p>

        <div className={labelCls}>工作目录（cwd）</div>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="脚本 / agent 会话的工作目录"
          className={`mono ${inputCls}`}
        />

        <label className="mt-3 flex items-center gap-2 text-sm text-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用（到点自动运行）
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
