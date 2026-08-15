import { useState } from "react";
import { chatStore } from "../lib/chat-store";
import { scheduleUpsert } from "../lib/pi-bridge";
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

/** Create/edit form for one scheduled task, saved via schedule_upsert. */
export default function TaskEditModal({ task, onClose }: Props) {
  const [name, setName] = useState(task?.name ?? "");
  const [id, setId] = useState(task?.id ?? "");
  const [kind, setKind] = useState<ScheduleTaskKind>(task?.kind ?? "watch");
  const [schedule, setSchedule] = useState(task?.schedule ?? "");
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
    const trimmedSchedule = schedule.trim();
    if (trimmedSchedule.split(/\s+/).length !== 5) {
      chatStore.pushToast("cron 表达式需为 5 个字段（分 时 日 月 周）", "warning");
      return;
    }
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

        <div className={labelCls}>cron 表达式（本地时区）</div>
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="*/10 * * * *"
          className={`mono ${inputCls}`}
        />
        <p className="mt-1 text-[10px] text-dim">5 个字段：分 时 日 月 周，如「*/10 * * * *」表示每 10 分钟。</p>

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
