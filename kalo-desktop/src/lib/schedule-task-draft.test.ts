import { expect, it } from "vitest";
import { defaultSpec } from "./schedule-spec";
import { prepareScheduleTask, type ScheduleTaskDraft } from "./schedule-task-draft";
import type { ScheduleTaskInfo } from "../types";

const draft = (extra: Partial<ScheduleTaskDraft> = {}): ScheduleTaskDraft => ({ id: "task-123", name: " 每日整理 ", kind: "agent", cwd: " C:\\notes ", schedule: defaultSpec(), script: "", cooldownMin: "", prompt: "整理昨天的笔记", model: "", enabled: false, ...extra });

it("builds an AI task with the selected schedule, explicit disabled state and platform path intact", () => {
  const result = prepareScheduleTask(draft({ schedule: { ...defaultSpec(), freq: "weekdays", hour: 17, minute: 30 } }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.task).toMatchObject({ id: "task-123", name: "每日整理", cwd: "C:\\notes", prompt: "整理昨天的笔记", kind: "agent", schedule: "30 17 * * 1-5", model: null, enabled: false });
  expect(result.task.script).toBeUndefined();
});

it("builds a script task and drops stale AI-only values", () => {
  const result = prepareScheduleTask(draft({ kind: "watch", cwd: "/Users/u/notes", script: "echo check", model: "provider/model", cooldownMin: "30" }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.task).toMatchObject({ script: "echo check", cooldownMin: 30, matchMode: "nonEmpty", cwd: "/Users/u/notes" });
  expect(result.task.prompt).toBeUndefined();
  expect(result.task.model).toBeUndefined();
});

it("preserves an existing task's identity, history and expert when changing its type", () => {
  const previous: ScheduleTaskInfo = { id: "old-id", name: "旧任务", kind: "watch", cwd: "/notes", schedule: "0 9 * * *", enabled: true, script: "old", expertId: "expert-a", lastRun: "2026-10-23", lastResult: "error", lastOutput: "old failure", nextRunAt: null, running: false };
  const result = prepareScheduleTask(draft({ id: "ignored", cooldownMin: "bad-hidden-script-value" }), previous);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.task).toMatchObject({ id: "old-id", expertId: "expert-a", lastRun: "2026-10-23", lastResult: "error", lastOutput: "old failure" });
  expect(result.task.script).toBeUndefined();
  expect(result.task.cooldownMin).toBeUndefined();
});

it("rejects missing user input without constructing a save payload", () => {
  for (const extra of [{ id: "bad/id" }, { name: " " }, { cwd: " " }, { prompt: " " }, { kind: "watch" as const, script: " " }, { kind: "watch" as const, script: "echo", cooldownMin: "-1" }, { kind: "watch" as const, script: "echo", cooldownMin: "NaN" }, { schedule: { ...defaultSpec(), freq: "weekly" as const, weekdays: [] } }]) {
    const result = prepareScheduleTask(draft(extra));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  }
});
