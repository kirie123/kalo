import { useState } from "react";
import { createPortal } from "react-dom";
import { chatStore } from "../lib/chat-store";
import { usePinnedBackdrop } from "../lib/modal-backdrop";
import { scheduleUpsert } from "../lib/pi-bridge";
import {
  buildCron,
  defaultSpec,
  describeCron,
  parseSpec,
  WEEKDAY_LABELS,
  type ScheduleFreq,
  type ScheduleSpec,
} from "../lib/schedule-spec";
import type { ScheduleTaskInfo, ScheduleTaskKind } from "../types";
import { prepareScheduleTask } from "../lib/schedule-task-draft";

interface Props {
  /** Given when editing an existing task; undefined for "new task". */
  task?: ScheduleTaskInfo;
  onClose: (saved: boolean) => void;
  embedded?: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const KIND_LABEL: Record<ScheduleTaskKind, string> = {
  watch: "脚本任务",
  agent: "AI 任务",
};

const KIND_HINT: Record<ScheduleTaskKind, string> = {
  watch: "定时执行本地脚本，有输出时发送告警。",
  agent: "描述要做的事，让 AI 在指定时间自动完成。",
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
export default function TaskEditModal({ task, onClose, embedded = false }: Props) {
  const backdrop = usePinnedBackdrop(`请用「取消」或「${task ? "保存更改" : "创建任务"}」结束编辑`);
  const [name, setName] = useState(task?.name ?? "");
  const [id, setId] = useState(() => task?.id ?? `task-${crypto.randomUUID()}`);
  const [kind, setKind] = useState<ScheduleTaskKind>(task?.kind ?? "agent");
  const [schedule, setSchedule] = useState<ScheduleSpec>(() =>
    task?.schedule ? parseSpec(task.schedule) : defaultSpec(),
  );
  const [cwd, setCwd] = useState(task?.cwd ?? chatStore.getSnapshot().cwd);
  const [script, setScript] = useState(task?.script ?? "");
  const [cooldownMin, setCooldownMin] = useState(task?.cooldownMin != null ? String(task.cooldownMin) : "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [model, setModel] = useState(task?.model ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (saving) return;
    setError("");
    const result = prepareScheduleTask({ id, name, kind, schedule, cwd, script, cooldownMin, prompt, model, enabled }, task);
    if (!result.ok) { setError(result.error); return; }
    const next = result.task;
    setSaving(true);
    try {
      await scheduleUpsert(next);
      chatStore.pushToast("任务已保存", "info");
      onClose(true);
    } catch (err) {
      setError(`保存失败：${errText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-edge bg-base px-3 py-1.5 text-sm outline-none focus:border-dim";
  const selectCls = "rounded-md border border-edge bg-base px-2 py-1 text-sm outline-none focus:border-dim";
  const labelCls = "mb-1 mt-3 text-xs text-dim";

  const content = (
      <div
        className={embedded ? "task-editor task-editor-embedded" : "task-editor task-editor-modal"}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="task-editor-title">{task ? "编辑定时任务" : "创建定时任务"}</h3>
        <p className="task-editor-intro">{task ? task.name : "写下要做的事，再选一个自动运行的时间。"}</p>
        {error && <div className="task-editor-error" role="alert">{error}</div>}
        <fieldset disabled={saving} className="task-editor-fields">

        <div className={labelCls}>名称</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：股价异动监控"
          autoFocus={!embedded}
          aria-label="任务名称"
          className={inputCls}
        />

        <div className={labelCls}>类型</div>
        <div className="flex gap-2">
          {(["agent", "watch"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
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
              aria-label="执行脚本"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={"curl -s ... | grep ...\n# 有输出即告警"}
              spellCheck={false}
              className="mono min-h-[120px] w-full resize-y rounded-md border border-edge bg-base p-3 text-xs leading-relaxed outline-none focus:border-dim"
            />
          </>
        ) : (
          <>
            <div className={labelCls}>任务内容</div>
            <textarea
              aria-label="任务内容"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：每个工作日整理项目进展，将需要我处理的事项列出来。"
              spellCheck={false}
              className="min-h-[100px] w-full resize-y rounded-md border border-edge bg-base p-3 text-sm leading-relaxed outline-none focus:border-dim"
            />
          </>
        )}

        <div className={labelCls}>运行时间（本地时区）</div>
        <div className="flex flex-wrap gap-1.5">
          {FREQ_ORDER.map((f) => (
            <button
              key={f}
              onClick={() => setSchedule({ ...schedule, freq: f })}
              aria-pressed={schedule.freq === f}
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
              {!MINUTE_STEPS.includes(schedule.everyMin) && <option value={schedule.everyMin}>每 {schedule.everyMin} 分钟</option>}
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
              aria-label="运行时间"
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
              aria-label="自定义运行规则"
              value={schedule.cron}
              onChange={(e) => setSchedule({ ...schedule, cron: e.target.value })}
              placeholder="*/10 * * * *"
              className={`mono ${inputCls}`}
            />
          )}
        </div>

        {/* Human-readable preview; custom cron remains an explicit advanced choice. */}
        <p className="mt-1.5 text-[10px] text-dim">
          {schedule.freq === "custom"
            ? "5 个字段：分 时 日 月 周，如「*/10 * * * *」表示每 10 分钟。"
            : `将于${describeCron(buildCron(schedule))}运行`}
        </p>

        <div className={labelCls}>工作目录</div>
        <input
          aria-label="工作目录"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="脚本 / agent 会话的工作目录"
          className={`mono ${inputCls}`}
        />

        <details className="task-editor-more"><summary>更多设置</summary>
        <div className={labelCls}>ID{task && "（不可修改）"}</div>
        <input
          aria-label="任务标识"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="字母数字与 - _，如 price-watch"
          disabled={Boolean(task)}
          className={`mono ${inputCls} disabled:opacity-40`}
        />
        {kind === "agent" ? <><div className={labelCls}>模型</div><input aria-label="模型" value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/modelId，留空用默认" className={`mono ${inputCls}`} /></>
          : <><div className={labelCls}>告警冷却（分钟，留空不冷却）</div><input aria-label="告警冷却分钟" type="number" min={0} value={cooldownMin} onChange={(event) => setCooldownMin(event.target.value)} placeholder="如 30" className={`mono ${inputCls}`} /></>}
        </details>
        <label className="mt-3 flex items-center gap-2 text-sm text-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用（到点自动运行）
        </label>

        </fieldset>
        <div className="task-editor-footer">
          <button
            onClick={() => onClose(false)}
            disabled={saving}
            className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            {embedded ? "重置" : "取消"}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "保存中…" : task ? "保存更改" : "创建任务"}
          </button>
        </div>
      </div>
  );
  return embedded ? <section aria-label={task ? "编辑定时任务" : "创建定时任务"}>{content}</section>
    : createPortal(<div className="task-editor-backdrop" role="dialog" aria-modal="true" aria-label={task ? "编辑定时任务" : "创建定时任务"} {...backdrop}>{content}</div>, document.body);
}
