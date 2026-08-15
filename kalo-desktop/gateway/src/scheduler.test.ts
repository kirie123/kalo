import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextCronTime,
  parseCron,
  validateCron,
  Scheduler,
  type ScheduleTask,
} from "./scheduler";

// ---------------------------------------------------------------------------
// cron parsing / next-fire computation
// ---------------------------------------------------------------------------

describe("cron", () => {
  const from = new Date("2026-08-15T14:30:45"); // a Saturday

  test("*/10 minute stepping", () => {
    const next = nextCronTime("*/10 * * * *", from)!;
    expect(next.getMinutes()).toBe(40);
    expect(next.getSeconds()).toBe(0);
  });

  test("fixed daily time later today", () => {
    const next = nextCronTime("0 22 * * *", from)!;
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(from.getDate());
  });

  test("fixed daily time already past → tomorrow", () => {
    const next = nextCronTime("0 9 * * *", from)!;
    expect(next.getDate()).toBe(from.getDate() + 1);
    expect(next.getHours()).toBe(9);
  });

  test("weekday-only skips the weekend", () => {
    // 2026-08-15 is a Saturday; next Mon-Fri 09:00 is Monday the 17th.
    const next = nextCronTime("0 9 * * 1-5", from)!;
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(17);
  });

  test("comma lists and ranges", () => {
    const next = nextCronTime("0,30 8-10 * * *", from)!;
    expect([0, 30]).toContain(next.getMinutes());
    expect(next.getHours()).toBeGreaterThanOrEqual(8);
    expect(next.getHours()).toBeLessThanOrEqual(10);
  });

  test("impossible date returns null", () => {
    expect(nextCronTime("0 0 30 2 *", from)).toBeNull();
  });

  test("invalid expressions throw / validate", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("99 * * * *")).toThrow();
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("hello")).not.toBeNull();
  });

  test("day-of-month OR day-of-week (Vixie rule)", () => {
    // "16th OR Monday": from Saturday the 15th, the 16th (Sunday) matches.
    const next = nextCronTime("0 0 16 * 1", from)!;
    expect(next.getDate()).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// scheduler behaviour
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-08-15T14:30:00");

function makeTask(overrides: Partial<ScheduleTask>): ScheduleTask {
  return {
    id: "t1",
    name: "测试任务",
    kind: "agent",
    schedule: "* * * * *",
    cwd: process.cwd(),
    prompt: "hello",
    enabled: true,
    ...overrides,
  };
}

function makeScheduler(dir?: string) {
  const storeDir = dir ?? mkdtempSync(join(tmpdir(), "kalo-sched-test-"));
  const alerts: string[] = [];
  const requests: ScheduleTask[] = [];
  const nowRef = { t: T0 };
  const scheduler = new Scheduler({
    sendAlert: (_task, output) => alerts.push(output),
    requestAgentSession: (task) => requests.push(task),
    onChange: () => {},
    now: () => nowRef.t,
    storeFile: join(storeDir, "schedules.json"),
  });
  return { scheduler, alerts, requests, nowRef, storeDir };
}

/** Cron fires on minute boundaries; jump past the next one, then tick. */
function fireOnce(nowRef: { t: number }, scheduler: Scheduler, advanceMs = 61_000): void {
  nowRef.t += advanceMs;
  scheduler.tick();
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("scheduler", () => {
  test("agent task: tick → session request → exit settles lastResult", () => {
    const { scheduler, requests, nowRef } = makeScheduler();
    expect(scheduler.upsert(makeTask({}))).toBeNull();
    fireOnce(nowRef, scheduler);
    expect(requests).toHaveLength(1);
    expect(requests[0].id).toBe("t1");
    scheduler.handleSessionStarted("t1", "sess-1");
    scheduler.handleSessionExit("sess-1", 0);
    expect(scheduler.list()[0].lastResult).toBe("ok");
  });

  test("agent task: non-zero exit marks error", () => {
    const { scheduler, nowRef } = makeScheduler();
    scheduler.upsert(makeTask({}));
    fireOnce(nowRef, scheduler);
    scheduler.handleSessionStarted("t1", "sess-1");
    scheduler.handleSessionExit("sess-1", 1);
    expect(scheduler.list()[0].lastResult).toBe("error");
  });

  test("agent task: spawn failure marks error", () => {
    const { scheduler, nowRef } = makeScheduler();
    scheduler.upsert(makeTask({}));
    fireOnce(nowRef, scheduler);
    scheduler.handleSessionStartFailed("t1", "pi binary not found");
    expect(scheduler.list()[0].lastResult).toBe("error");
  });

  test("disabled task never fires; nextRunAt hidden in snapshot", () => {
    const { scheduler, requests, nowRef } = makeScheduler();
    scheduler.upsert(makeTask({ enabled: false }));
    fireOnce(nowRef, scheduler);
    expect(requests).toHaveLength(0);
    expect(scheduler.list()[0].nextRunAt).toBeNull();
  });

  test("missed fire time collapses into a single catch-up run", () => {
    const { scheduler, requests, nowRef } = makeScheduler();
    scheduler.upsert(makeTask({}));
    // Simulate a 10-minute sleep gap, then one tick: exactly one run.
    nowRef.t += 10 * 60_000;
    scheduler.tick();
    expect(requests).toHaveLength(1);
  });

  test("invalid cron is rejected", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.upsert(makeTask({ schedule: "not a cron" }))).not.toBeNull();
    expect(scheduler.list()).toHaveLength(0);
  });

  test("watch task: non-empty output alerts once, cooldown suppresses repeat", async () => {
    const { scheduler, alerts, nowRef } = makeScheduler();
    const err = scheduler.upsert(
      makeTask({ kind: "watch", script: "echo ALARM", cooldownMin: 30, prompt: undefined }),
    );
    expect(err).toBeNull();
    fireOnce(nowRef, scheduler);
    await waitFor(() => alerts.length > 0);
    expect(alerts[0]).toContain("ALARM");
    expect(scheduler.list()[0].lastResult).toBe("alerted");

    // One minute later, still inside the 30min cooldown → skipped entirely.
    fireOnce(nowRef, scheduler);
    await new Promise((r) => setTimeout(r, 300));
    expect(alerts).toHaveLength(1);
  });

  test("watch task: empty output is silent and ok", async () => {
    const { scheduler, alerts, nowRef } = makeScheduler();
    scheduler.upsert(makeTask({ kind: "watch", script: "true", prompt: undefined }));
    fireOnce(nowRef, scheduler);
    await waitFor(() => scheduler.list()[0].lastResult !== undefined);
    expect(alerts).toHaveLength(0);
    expect(scheduler.list()[0].lastResult).toBe("ok");
  });

  test("persistence round-trip via schedules.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalo-sched-test-"));
    const { scheduler } = makeScheduler(dir);
    scheduler.upsert(makeTask({ id: "persist-me" }));
    const raw = JSON.parse(readFileSync(join(dir, "schedules.json"), "utf-8"));
    expect(raw.tasks[0].id).toBe("persist-me");

    const { scheduler: reloaded } = makeScheduler(dir);
    reloaded.load();
    expect(reloaded.list().map((t) => t.id)).toContain("persist-me");
    rmSync(dir, { recursive: true, force: true });
  });
});
