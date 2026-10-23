import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, type ScheduleTask } from "./scheduler";

const fixtures: Array<{ dir: string; scheduler: Scheduler }> = [];
afterEach(() => {
  for (const { dir, scheduler } of fixtures.splice(0)) {
    scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kalo-scheduler-audit-"));
  const store = join(dir, "schedules.json");
  const alerts: string[] = [];
  const requests: string[] = [];
  const scheduler = new Scheduler({ storeFile: store, onChange: () => {},
    sendAlert: (_task, output) => alerts.push(output), requestAgentSession: (_task, id) => requests.push(id),
    agentStartTimeoutMs: 40, watchTimeoutMs: 200,
  });
  const task: ScheduleTask = { id: "audit", name: "测试", kind: "agent", prompt: "test", cwd: dir, schedule: "* * * * *", enabled: true };
  fixtures.push({ dir, scheduler });
  return { dir, store, scheduler, task, alerts, requests };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await Bun.sleep(20); }
  throw new Error("scheduler did not settle");
}
describe("scheduler usability regressions", () => {
  test("a settled RPC run unlocks the next run without waiting for process exit", () => {
    const { scheduler, task, requests } = fixture();
    scheduler.upsert(task); scheduler.runNow(task.id);
    scheduler.handleSessionStarted(requests[0], "session-a");
    scheduler.handleEvent("session-a", { type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error" }] });
    expect(scheduler.list()[0].running).toBe(true);
    scheduler.handleEvent("session-a", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    expect(scheduler.handleEvent("session-a", { type: "agent_settled" })).toBe(true);
    expect(scheduler.list()[0].lastResult).toBe("ok");
    scheduler.handleSessionExit("session-a", 1);
    expect(scheduler.list()[0].lastResult).toBe("ok");
    expect(scheduler.runNow(task.id)).toBeNull();
    expect(requests).toHaveLength(2);
  });
  test("editing an active task preserves the run lock, expert identity and history", () => {
    const { scheduler, task, requests } = fixture();
    scheduler.upsert({ ...task, expertId: "research" }); scheduler.runNow(task.id);
    scheduler.handleSessionStarted(requests[0], "session-a");
    scheduler.upsert({ ...task, expertId: "research", name: "修改", enabled: false });
    expect(scheduler.list()[0].running).toBe(true);
    expect(scheduler.runNow(task.id)).toContain("正在运行");
    scheduler.handleEvent("session-a", { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "test failure" }] });
    scheduler.handleEvent("session-a", { type: "agent_settled" });
    scheduler.upsert({ ...task, expertId: "research" });
    expect(scheduler.list()[0].lastOutput).toBe("test failure");
    expect(scheduler.list()[0].lastResult).toBe("error");
  });
  test("a rejected model request settles and requests cleanup", () => {
    const { scheduler, task, requests } = fixture();
    scheduler.upsert(task); scheduler.runNow(task.id);
    scheduler.handleSessionStarted(requests[0], "session-a");
    expect(scheduler.handleEvent("session-a", { type: "response", id: "sched-model-session-a", success: false, error: "unknown model" })).toBe(true);
    expect(scheduler.list()[0].running).toBe(false);
    expect(scheduler.list()[0].lastOutput).toContain("unknown model");
  });
  test("a late startup acknowledgement cannot bind to a newer attempt", async () => {
    const { scheduler, task, requests } = fixture();
    scheduler.upsert(task); scheduler.runNow(task.id);
    await until(() => !scheduler.list()[0].running);
    scheduler.runNow(task.id);
    expect(requests[0]).not.toBe(requests[1]);
    expect(scheduler.handleSessionStarted(requests[0], "stale")).toBe(false);
    scheduler.handleSessionStartFailed(requests[0], "stale failure");
    expect(scheduler.list()[0].running).toBe(true);
    expect(scheduler.handleSessionStarted(requests[1], "new")).toBe(true);
  });
  test("a removed and recreated ID is isolated from old session exits", () => {
    const { scheduler, task, requests } = fixture();
    scheduler.upsert(task); scheduler.runNow(task.id); scheduler.handleSessionStarted(requests[0], "old");
    scheduler.remove(task.id); scheduler.upsert({ ...task }); scheduler.runNow(task.id);
    scheduler.handleSessionExit("old", 1);
    expect(scheduler.list()[0].running).toBe(true);
    expect(scheduler.list()[0].lastResult).toBeUndefined();
  });
  test("manual watch runs ignore both disabled and cooldown", async () => {
    const { scheduler, task, alerts } = fixture();
    scheduler.upsert({ ...task, enabled: false, kind: "watch", script: "echo manual", cooldownMin: 60 });
    scheduler.runNow(task.id); await until(() => alerts.length === 1);
    scheduler.runNow(task.id); await until(() => alerts.length === 2);
    expect(scheduler.list()[0].lastResult).toBe("alerted");
  });
  test("an invalid cwd fails instead of executing in a fallback directory", async () => {
    const { scheduler, task, dir, store } = fixture();
    scheduler.upsert({ ...task, kind: "watch", cwd: join(dir, "missing"), script: "echo SHOULD_NOT_RUN" });
    scheduler.runNow(task.id);
    expect(scheduler.list()[0].lastResult).toBe("error");
    expect(JSON.parse(readFileSync(store, "utf8")).tasks[0].lastOutput).toContain("工作目录不可用");
  });
  test("timeout details are saved before the failure snapshot is published", async () => {
    const { scheduler, task, store } = fixture();
    scheduler.upsert({ ...task, kind: "watch", script: "sleep 30" }); scheduler.runNow(task.id);
    await until(() => scheduler.list()[0].lastResult === "error");
    expect(JSON.parse(readFileSync(store, "utf8")).tasks[0].lastOutput).toContain("超时");
  });
  test("persistence failure does not publish an unsaved task", () => {
    const { scheduler, task, store } = fixture();
    // A directory at the atomic replacement path makes the write fail on both platforms.
    mkdirSync(store + ".tmp");
    expect(scheduler.upsert(task)).toContain("保存任务失败");
    expect(scheduler.list()).toHaveLength(0);
  });
});
