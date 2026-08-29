import { describe, expect, it } from "vitest";
import type { RunningJobSession, ScheduleTaskInfo } from "../types";
import { fmtTime, gatewaySessions, runRow, runRows } from "./task-run-view";

function task(over: Partial<ScheduleTaskInfo> = {}): ScheduleTaskInfo {
  return {
    id: "t1",
    name: "任务",
    kind: "watch",
    schedule: "* * * * *",
    cwd: "/tmp",
    enabled: true,
    nextRunAt: null,
    running: false,
    ...over,
  };
}

function session(over: Partial<RunningJobSession> = {}): RunningJobSession {
  return {
    id: "s1",
    kind: "session",
    name: "定时 会话",
    source: "gateway",
    cwd: "/tmp",
    state: "running",
    startedAt: "1782000000",
    ...over,
  };
}

describe("runRow", () => {
  it("running beats everything", () => {
    const row = runRow(task({ running: true, lastResult: "error", lastRun: "2026-08-29T07:00:00Z" }));
    expect(row.status).toBe("running");
    expect(row.statusLabel).toBe("运行中");
  });

  it("never run → idle", () => {
    expect(runRow(task()).status).toBe("idle");
    expect(runRow(task({ lastRun: "2026-08-29T07:00:00Z" })).status).toBe("idle");
  });

  it("alerted explains itself", () => {
    const row = runRow(task({ lastRun: "x", lastResult: "alerted" }));
    expect(row.statusLabel).toBe("已告警");
    expect(row.tone).toBe("warn");
    expect(row.hint).toContain("告警");
  });

  it("error copy differs by kind", () => {
    expect(runRow(task({ kind: "watch", lastRun: "x", lastResult: "error" })).hint).toContain("脚本");
    expect(runRow(task({ kind: "agent", lastRun: "x", lastResult: "error" })).hint).toContain("会话");
  });

  it("ok maps to 正常", () => {
    const row = runRow(task({ lastRun: "x", lastResult: "ok" }));
    expect(row.statusLabel).toBe("正常");
    expect(row.tone).toBe("ok");
  });
});

describe("runRows ordering", () => {
  it("running first, then most recent lastRun, never-run last", () => {
    const rows = runRows([
      task({ id: "old", lastRun: "2026-08-01T00:00:00Z", lastResult: "ok" }),
      task({ id: "never" }),
      task({ id: "live", running: true }),
      task({ id: "new", lastRun: "2026-08-29T00:00:00Z", lastResult: "error" }),
    ]);
    expect(rows.map((r) => r.task.id)).toEqual(["live", "new", "old", "never"]);
  });
});

describe("gatewaySessions", () => {
  it("keeps only gateway-spawned sessions", () => {
    const all = [session({ id: "a" }), session({ id: "b", source: "desktop" })];
    expect(gatewaySessions(all).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("fmtTime", () => {
  it("formats ISO to local YYYY-MM-DD HH:mm", () => {
    expect(fmtTime("2026-08-29T13:05:00")).toBe("2026-08-29 13:05");
  });
  it("handles empty and invalid input", () => {
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime("not-a-date")).toBe("not-a-date");
  });
});
