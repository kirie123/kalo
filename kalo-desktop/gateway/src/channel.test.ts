import { describe, expect, test } from "bun:test";
import { Channel, CONFIRM_TTL_MS, normalize, type ChannelTransport } from "./channel";
import type { JobSnapshot } from "./jobs/types";
import type { ScheduleTaskInfo } from "./scheduler";

const T0 = Date.parse("2026-08-15T14:30:00");

interface Harness {
  channel: Channel;
  sent: string[];
  killed: Array<{ id: string; reason?: string }>;
  sessions: Array<{ taskId: string; prompt: string }>;
  jobs: JobSnapshot[];
  tasks: ScheduleTaskInfo[];
  nowRef: { value: number };
  connected: { value: boolean };
}

function job(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "gateway-1",
    kind: "gateway",
    label: "长跑",
    status: "running",
    startedAt: T0,
    reported: false,
    ...over,
  };
}

function makeChannel(): Harness {
  const h: Harness = {
    channel: null as unknown as Channel,
    sent: [],
    killed: [],
    sessions: [],
    jobs: [job()],
    tasks: [],
    nowRef: { value: T0 },
    connected: { value: true },
  };
  const transport: ChannelTransport = {
    sendText: async (text) => {
      h.sent.push(text);
      return `m${h.sent.length}`;
    },
    updateText: async () => {},
  };
  h.channel = new Channel({
    transport: () => (h.connected.value ? transport : null),
    listJobs: () => h.jobs,
    killJob: (id, reason) => {
      h.killed.push({ id, reason });
      return "requested";
    },
    listSchedules: () => h.tasks,
    requestSession: (taskId, prompt) => {
      h.sessions.push({ taskId, prompt });
    },
    cwd: () => "C:/home",
    now: () => h.nowRef.value,
  });
  return h;
}

const last = (h: Harness) => h.sent[h.sent.length - 1] ?? "";

describe("normalize", () => {
  test("strips mentions, zero-width marks and collapses whitespace", () => {
    expect(normalize("@_user_1  /status \u200b")).toBe("/status");
    expect(normalize("  ")).toBe("");
  });
});

describe("Channel commands", () => {
  test("/status renders jobs and schedules without touching them", async () => {
    const h = makeChannel();
    h.jobs = [job({ id: "gateway-7", label: "回测", status: "queued" })];
    h.tasks = [
      { id: "t1", name: "早报", kind: "agent", schedule: "0 8 * * *", cwd: "C:/", enabled: true, nextRunAt: "08:00" },
    ];

    await h.channel.handleText("/status");

    expect(last(h)).toContain("gateway-7");
    expect(last(h)).toContain("回测");
    expect(last(h)).toContain("等待门控");
    expect(last(h)).toContain("早报");
    expect(h.killed).toEqual([]);
  });

  test("/stop asks first and only /ok executes it", async () => {
    const h = makeChannel();

    await h.channel.handleText("/stop gateway-1");
    expect(h.killed).toEqual([]);
    expect(last(h)).toContain("确认");
    expect(h.channel.pendingDescription()).toContain("gateway-1");

    await h.channel.handleText("/ok");
    expect(h.killed.map((k) => k.id)).toEqual(["gateway-1"]);
    expect(h.channel.pendingDescription()).toBeNull();
  });

  test("a pending confirmation expires after 60s", async () => {
    const h = makeChannel();
    await h.channel.handleText("/stop gateway-1");

    h.nowRef.value += CONFIRM_TTL_MS + 1;
    await h.channel.handleText("/ok");

    expect(h.killed).toEqual([]);
    expect(last(h)).toContain("没有待确认");
  });

  test("/ok applies to the most recent pending item only", async () => {
    const h = makeChannel();
    h.jobs = [job({ id: "gateway-1" }), job({ id: "gateway-2", label: "另一个" })];

    await h.channel.handleText("/stop gateway-1");
    await h.channel.handleText("/stop gateway-2");
    await h.channel.handleText("/ok");
    await h.channel.handleText("/ok");

    expect(h.killed.map((k) => k.id)).toEqual(["gateway-2"]);
    expect(last(h)).toContain("没有待确认");
  });

  test("/stop resolves a unique live label and rejects unknown targets", async () => {
    const h = makeChannel();

    await h.channel.handleText("/stop 长跑");
    await h.channel.handleText("/ok");
    expect(h.killed.map((k) => k.id)).toEqual(["gateway-1"]);

    await h.channel.handleText("/stop 不存在");
    expect(last(h)).toContain("没有找到");
    expect(h.killed.length).toBe(1);
  });

  test("/stop without an argument explains itself", async () => {
    const h = makeChannel();
    await h.channel.handleText("/stop");
    expect(last(h)).toContain("用法");
  });

  test("an unknown command falls back to help, not to a session", async () => {
    const h = makeChannel();
    await h.channel.handleText("/nope");
    expect(last(h)).toContain("未知命令");
    expect(h.sessions).toEqual([]);
  });
});

describe("Channel natural language", () => {
  test("plain text opens a session through the session_request handshake", async () => {
    const h = makeChannel();
    await h.channel.handleText("看看今天的实验跑得怎么样");

    expect(h.sessions.length).toBe(1);
    expect(h.sessions[0].prompt).toBe("看看今天的实验跑得怎么样");
    expect(h.channel.owns(h.sessions[0].taskId)).toBe(true);
    expect(h.killed).toEqual([]);
  });

  test("a failed start is reported once and then forgotten", async () => {
    const h = makeChannel();
    await h.channel.handleText("随便说点什么");
    const taskId = h.sessions[0].taskId;

    h.channel.handleSessionStartFailed(taskId, "spawn 失败");
    expect(last(h)).toContain("spawn 失败");

    const before = h.sent.length;
    h.channel.handleSessionStartFailed(taskId, "spawn 失败");
    expect(h.sent.length).toBe(before);
  });

  test("a started session silences the pending-start bookkeeping", async () => {
    const h = makeChannel();
    await h.channel.handleText("你好");
    const taskId = h.sessions[0].taskId;

    h.channel.handleSessionStarted(taskId);
    const before = h.sent.length;
    h.channel.handleSessionStartFailed(taskId, "迟到的失败");
    expect(h.sent.length).toBe(before);
  });

  test("scheduler task ids are not claimed by the channel", () => {
    const h = makeChannel();
    expect(h.channel.owns("t1")).toBe(false);
  });
});

describe("Channel ask / transport", () => {
  test("ask is answered by the next inbound line, before any parsing", async () => {
    const h = makeChannel();
    const answer = h.channel.ask("选哪个？", { choices: ["A", "B"] });
    expect(last(h)).toContain("选哪个？");
    expect(last(h)).toContain("· A");

    await h.channel.handleText("/status"); // consumed as the answer
    expect(await answer).toBe("/status");
    expect(h.sent.filter((s) => s.includes("任务："))).toEqual([]);
  });

  test("nothing is ingested or sent once the transport is gone", async () => {
    const h = makeChannel();
    h.connected.value = false;

    await h.channel.handleText("/stop gateway-1");
    expect(h.sent).toEqual([]);
    expect(h.killed).toEqual([]);
  });
});
