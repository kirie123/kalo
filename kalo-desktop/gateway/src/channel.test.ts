import { describe, expect, test } from "bun:test";
import { Channel, CONFIRM_TTL_MS, chunkText, normalize, type ChannelTransport } from "./channel";
import type { JobSnapshot } from "./jobs/types";
import type { ScheduleTaskInfo } from "./scheduler";

const T0 = Date.parse("2026-08-15T14:30:00");

interface Harness {
  channel: Channel;
  sent: string[];
  killed: Array<{ id: string; reason?: string }>;
  sessions: Array<{ taskId: string; prompt: string }>;
  prompts: Array<{ sessionId: string; prompt: string }>;
  reactions: Array<{ messageId: string; emoji: string }>;
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
    prompts: [],
    reactions: [],
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
    addReaction: async (messageId, emoji) => {
      h.reactions.push({ messageId, emoji });
    },
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
    sendPrompt: (sessionId, prompt) => {
      h.prompts.push({ sessionId, prompt });
    },
    cwd: () => "C:/home",
    now: () => h.nowRef.value,
  });
  return h;
}

/** Drive one full turn: message in → session started → answer out. */
async function turn(h: Harness, text: string, sessionId = "s1"): Promise<void> {
  await h.channel.handleText(text);
  const task = h.sessions[h.sessions.length - 1];
  h.channel.handleSessionStarted(task.taskId, sessionId);
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

describe("Channel conversation", () => {
  test("the answer is delivered in full as its own message", async () => {
    // The whole point of the feature: the progress card is truncated, so the
    // answer must arrive separately and intact.
    const h = makeChannel();
    await turn(h, "帮我看看这个 bug");

    const answer = "根因在 feishu.ts：取值取错了一层。" + "细节".repeat(50);
    await h.channel.handleAnswer("s1", answer);

    expect(h.sent).toContain(answer);
  });

  test("a follow-up reuses the session instead of opening a new one", async () => {
    const h = makeChannel();
    await turn(h, "第一个问题");
    await h.channel.handleAnswer("s1", "第一个回答");

    await h.channel.handleText("那第二个呢");

    expect(h.prompts).toEqual([{ sessionId: "s1", prompt: "那第二个呢" }]);
    // Still exactly one session: this is what gives multi-turn context.
    expect(h.sessions.length).toBe(1);
  });

  test("/new drops the context so the next message opens a fresh session", async () => {
    const h = makeChannel();
    await turn(h, "第一个问题");
    await h.channel.handleAnswer("s1", "答");

    await h.channel.handleText("/new");
    expect(last(h)).toContain("新对话");

    await h.channel.handleText("重新开始");
    expect(h.prompts).toEqual([]);
    expect(h.sessions.length).toBe(2);
  });

  test("a message arriving mid-run is queued, then runs on its own", async () => {
    const h = makeChannel();
    await turn(h, "慢活");

    await h.channel.handleText("插一句");
    expect(h.prompts).toEqual([]); // not delivered while busy
    expect(last(h)).toContain("排在第 1 位");

    await h.channel.handleAnswer("s1", "慢活干完了");
    expect(h.prompts).toEqual([{ sessionId: "s1", prompt: "插一句" }]);
  });

  test("the queue is bounded rather than growing without limit", async () => {
    const h = makeChannel();
    await turn(h, "慢活");

    for (let i = 0; i < 8; i++) await h.channel.handleText(`第${i}条`);

    expect(last(h)).toContain("没接住");
  });

  test("a dead session is reopened with the message preserved", async () => {
    const h = makeChannel();
    await turn(h, "第一个问题");
    await h.channel.handleAnswer("s1", "答");

    await h.channel.handleText("跟进问题");
    h.channel.handleSessionPromptFailed("s1", "会话已不存在");

    // The user's message is retried in a fresh session, not dropped.
    expect(h.sessions.length).toBe(2);
    expect(h.sessions[1].prompt).toBe("跟进问题");
    expect(h.sent.some((s) => s.includes("已失效"))).toBe(true);
  });

  test("an answer from a stale session is ignored", async () => {
    const h = makeChannel();
    await turn(h, "问题", "s1");
    const before = h.sent.length;

    await h.channel.handleAnswer("s-old", "来自旧会话的回答");
    expect(h.sent.length).toBe(before);
  });

  test("inbound messages get an immediate read receipt", async () => {
    // A run takes minutes; silence is exactly what the original bug looked
    // like, so the user needs to see the message land.
    const h = makeChannel();
    await h.channel.handleText("干活", "om_1");
    expect(h.reactions).toEqual([{ messageId: "om_1", emoji: "OnIt" }]);
  });

  test("session exit ends the conversation and frees the channel", async () => {
    const h = makeChannel();
    await turn(h, "问题");

    h.channel.handleSessionExit("s1");
    expect(h.sent.some((s) => s.includes("会话已结束"))).toBe(true);

    // The next message is not stuck behind the dead run.
    await h.channel.handleText("再来一次");
    expect(h.sessions.length).toBe(2);
  });

  test("a failed start frees the channel for the next message", async () => {
    const h = makeChannel();
    await h.channel.handleText("第一次");
    h.channel.handleSessionStartFailed(h.sessions[0].taskId, "spawn 失败");

    await h.channel.handleText("第二次");
    expect(h.sessions.length).toBe(2);
    expect(h.sent.some((s) => s.includes("排在第"))).toBe(false);
  });

  test("commands still work while a run is in flight", async () => {
    // /status must not queue behind a long run — it is read-only.
    const h = makeChannel();
    await turn(h, "慢活");

    await h.channel.handleText("/status");
    expect(last(h)).toContain("任务：");
  });
});

describe("chunkText", () => {
  test("short text stays one piece", () => {
    expect(chunkText("hi", 100)).toEqual(["hi"]);
  });

  test("splits on line boundaries and loses nothing", () => {
    const text = ["aaaa", "bbbb", "cccc"].join("\n");
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(text);
  });

  test("hard-splits a single over-long line", () => {
    const chunks = chunkText("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("every chunk respects the limit", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    for (const chunk of chunkText(text, 50)) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  test("empty input produces nothing to send", () => {
    expect(chunkText("   ", 10)).toEqual([]);
  });
});
