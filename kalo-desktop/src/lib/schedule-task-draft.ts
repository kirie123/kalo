import type { ScheduleTask, ScheduleTaskInfo, ScheduleTaskKind } from "../types";
import { buildCron, validateSpec, type ScheduleSpec } from "./schedule-spec";

export interface ScheduleTaskDraft {
  id: string; name: string; kind: ScheduleTaskKind; schedule: ScheduleSpec; cwd: string;
  script: string; cooldownMin: string; prompt: string; model: string; enabled: boolean;
}

/** Validate exactly the payload being saved, independent of UI and IPC. */
export function prepareScheduleTask(draft: ScheduleTaskDraft, previous?: ScheduleTaskInfo): { ok: true; task: ScheduleTask } | { ok: false; error: string } {
  const invalid = (error: string) => ({ ok: false as const, error });
  if (!previous && !/^[\w-]{1,64}$/.test(draft.id.trim())) return invalid("任务标识只能包含字母、数字、下划线、连字符（1-64 字符）");
  if (!draft.name.trim()) return invalid("请填写任务名称");
  const scheduleError = validateSpec(draft.schedule);
  if (scheduleError) return invalid(scheduleError);
  if (!draft.cwd.trim()) return invalid("请填写工作目录");
  if (draft.kind === "watch" && !draft.script.trim()) return invalid("请填写要执行的脚本");
  if (draft.kind === "agent" && !draft.prompt.trim()) return invalid("请填写需要定时完成的任务内容");
  const cooldown = draft.kind === "watch" && draft.cooldownMin.trim() ? Number(draft.cooldownMin) : undefined;
  if (cooldown !== undefined && (!Number.isFinite(cooldown) || cooldown < 0)) return invalid("冷却分钟数无效");
  return { ok: true, task: {
    id: previous?.id ?? draft.id.trim(), name: draft.name.trim(), kind: draft.kind, schedule: buildCron(draft.schedule), cwd: draft.cwd.trim(), enabled: draft.enabled,
    script: draft.kind === "watch" ? draft.script : undefined, matchMode: draft.kind === "watch" ? "nonEmpty" : undefined,
    cooldownMin: cooldown, prompt: draft.kind === "agent" ? draft.prompt : undefined, model: draft.kind === "agent" ? draft.model.trim() || null : undefined,
    lastRun: previous?.lastRun, lastResult: previous?.lastResult, lastOutput: previous?.lastOutput, expertId: previous?.expertId,
  } };
}
