import { describe, expect, it } from "vitest";
import {
  expertCards,
  expertDetail,
  fmtNextRun,
  fmtStartedAt,
  memoryDirPath,
  missionSummary,
  sessionSourceLabel,
  sessionTitles,
} from "./expert-view";
import type { Expert, RunningJobSession, ScheduleTaskInfo } from "../types";

function expert(over: Partial<Expert> = {}): Expert {
  return {
    id: "exp-1",
    name: "投资专家",
    workdir: "D:/experts/invest",
    mission: "每日收盘后分析并记录决策",
    createdAt: "2026-08-29T00:00:00.000Z",
    enabled: true,
    ...over,
  };
}

function running(over: Partial<RunningJobSession> = {}): RunningJobSession {
  return {
    id: "sess-1",
    kind: "session",
    name: "收盘飞轮",
    source: "gateway",
    cwd: "D:/experts/invest",
    state: "running",
    startedAt: "1782000000",
    expertId: "exp-1",
    ...over,
  };
}

function task(over: Partial<ScheduleTaskInfo> = {}): ScheduleTaskInfo {
  return {
    id: "task-1",
    name: "收盘飞轮",
    kind: "agent",
    schedule: "30 15 * * 1-5",
    cwd: "D:/experts/invest",
    enabled: true,
    expertId: "exp-1",
    nextRunAt: null,
    running: false,
    ...over,
  };
}

describe("expertCards", () => {
  it("is empty when there are no experts", () => {
    expect(expertCards([], [running()], [task()])).toEqual([]);
  });

  it("reports zero activity when the expert has no sessions and no tasks", () => {
    const [card] = expertCards([expert()], [], []);
    expect(card.runningCount).toBe(0);
    expect(card.enabledTaskCount).toBe(0);
    expect(card.nextRunAt).toBeNull();
  });

  it("counts only sessions and tasks bound to that expertId", () => {
    const cards = expertCards(
      [expert(), expert({ id: "exp-2", name: "翻译专家" })],
      [
        running({ id: "a" }),
        running({ id: "b", source: "desktop" }),
        running({ id: "c", expertId: "exp-2" }),
        running({ id: "d", expertId: null }),
        running({ id: "e", expertId: undefined }),
      ],
      [task({ id: "t1" }), task({ id: "t2", expertId: "exp-2" }), task({ id: "t3", expertId: undefined })],
    );
    expect(cards[0].runningCount).toBe(2);
    expect(cards[0].enabledTaskCount).toBe(1);
    expect(cards[1].runningCount).toBe(1);
    expect(cards[1].enabledTaskCount).toBe(1);
  });

  it("takes the earliest next run among the enabled tasks", () => {
    const [card] = expertCards(
      [expert()],
      [],
      [
        task({ id: "late", nextRunAt: "2026-08-30T07:30:00.000Z" }),
        task({ id: "early", nextRunAt: "2026-08-29T07:30:00.000Z" }),
        task({ id: "never", nextRunAt: null }),
      ],
    );
    expect(card.nextRunAt).toBe("2026-08-29T07:30:00.000Z");
    expect(card.enabledTaskCount).toBe(3);
  });

  it("ignores disabled tasks even when they carry a stale nextRunAt", () => {
    const [card] = expertCards(
      [expert()],
      [],
      [
        task({ id: "off", enabled: false, nextRunAt: "2026-08-29T01:00:00.000Z" }),
        task({ id: "on", nextRunAt: "2026-08-30T07:30:00.000Z" }),
      ],
    );
    expect(card.enabledTaskCount).toBe(1);
    expect(card.nextRunAt).toBe("2026-08-30T07:30:00.000Z");
  });

  it("has no next run when every task is disabled", () => {
    const [card] = expertCards(
      [expert()],
      [],
      [task({ enabled: false, nextRunAt: "2026-08-29T01:00:00.000Z" })],
    );
    expect(card.enabledTaskCount).toBe(0);
    expect(card.nextRunAt).toBeNull();
  });
});

describe("expertDetail", () => {
  it("is empty when nothing is bound to the expert", () => {
    expect(expertDetail("exp-1", [], [])).toEqual({ sessions: [], tasks: [] });
  });

  it("filters running sessions by expertId and labels the source", () => {
    const detail = expertDetail("exp-1", [
      running({ id: "a", source: "desktop" }),
      running({ id: "b", source: "gateway" }),
      running({ id: "c", expertId: "exp-2" }),
    ], []);
    expect(detail.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(detail.sessions.map((s) => s.sourceLabel)).toEqual(["桌面", "定时"]);
  });

  it("filters tasks by expertId and keeps the disabled flag", () => {
    const detail = expertDetail("exp-1", [], [
      task({ id: "t1" }),
      task({ id: "t2", enabled: false }),
      task({ id: "t3", expertId: "exp-2" }),
    ]);
    expect(detail.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(detail.tasks.map((t) => t.enabled)).toEqual([true, false]);
  });

  it("attaches session titles from the titles map, absent when unknown", () => {
    const titles = new Map([["a", "当前账户与宏观环境盘点"]]);
    const detail = expertDetail("exp-1", [running({ id: "a" }), running({ id: "b" })], [], titles);
    expect(detail.sessions[0].title).toBe("当前账户与宏观环境盘点");
    expect(detail.sessions[1].title).toBeUndefined();
  });
});

describe("sessionTitles", () => {
  it("flattens project groups into an id → title map, skipping empty titles", () => {
    const map = sessionTitles([
      { sessions: [{ id: "a", title: "标题A" }, { id: "b", title: "" }] },
      { sessions: [{ id: "c", title: "标题C" }] },
    ]);
    expect(map.get("a")).toBe("标题A");
    expect(map.has("b")).toBe(false);
    expect(map.get("c")).toBe("标题C");
  });
});

describe("fmtStartedAt", () => {
  it("converts unix-seconds strings and rejects garbage", () => {
    const iso = new Date(2026, 7, 29, 15, 30).toISOString();
    const secs = String(Date.parse(iso) / 1000);
    expect(fmtStartedAt(secs)).toBe("08-29 15:30");
    expect(fmtStartedAt("")).toBe("—");
    expect(fmtStartedAt("abc")).toBe("—");
    expect(fmtStartedAt("0")).toBe("—");
  });
});

describe("fmtNextRun", () => {
  it("marks a missing timestamp", () => {
    expect(fmtNextRun(null)).toBe("—");
    expect(fmtNextRun("")).toBe("—");
    expect(fmtNextRun(undefined)).toBe("—");
  });

  it("passes an unparsable string through instead of showing NaN", () => {
    expect(fmtNextRun("稍后")).toBe("稍后");
  });

  it("renders zero-padded local month-day and time", () => {
    // Built from local parts so the assertion holds in any timezone.
    const iso = new Date(2026, 7, 29, 9, 5, 3).toISOString();
    expect(fmtNextRun(iso)).toBe("08-29 09:05");
  });
});

describe("memoryDirPath", () => {
  it("appends the memory dir and strips trailing separators", () => {
    expect(memoryDirPath("D:/experts/invest")).toBe("D:/experts/invest/.kalo/memory");
    expect(memoryDirPath("D:\\experts\\invest\\")).toBe("D:\\experts\\invest/.kalo/memory");
  });
});

describe("missionSummary", () => {
  it("takes the first non-empty line", () => {
    expect(missionSummary("\n  每日收盘后分析 \n第二行")).toBe("每日收盘后分析");
  });

  it("caps long missions with an ellipsis", () => {
    const long = "使".repeat(80);
    expect(missionSummary(long)).toBe(`${"使".repeat(60)}…`);
  });
});

describe("sessionSourceLabel", () => {
  it("matches the job center's labels", () => {
    expect(sessionSourceLabel("gateway")).toBe("定时");
    expect(sessionSourceLabel("desktop")).toBe("桌面");
  });
});
