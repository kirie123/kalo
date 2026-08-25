/**
 * Renderer tests, focused on the answer-extraction path.
 *
 * The progress card is a truncated, overwritten-in-place live view; the final
 * answer has to escape it intact. That extraction (agent_end captures the full
 * text, agent_settled hands it to onAnswer) is what these tests pin down.
 */

import { describe, expect, test } from "bun:test";
import { ProgressRenderer, latestSentence } from "./renderer";
import type { FeishuConnection } from "./feishu";

/** A FeishuConnection stand-in that records what would go out. */
function fakeFeishu() {
  const sent: string[] = [];
  const updated: Array<{ messageId: string; text: string }> = [];
  let seq = 0;
  const conn = {
    sendText: async (text: string) => {
      sent.push(text);
      return `m${++seq}`;
    },
    updateText: async (messageId: string, text: string) => {
      updated.push({ messageId, text });
    },
    addReaction: async () => {},
  };
  return { conn: conn as unknown as FeishuConnection, sent, updated };
}

function harness() {
  const { conn, sent, updated } = fakeFeishu();
  const answers: Array<{ sessionId: string; answer: string }> = [];
  const renderer = new ProgressRenderer(conn, {
    onAnswer: (sessionId, answer) => answers.push({ sessionId, answer }),
  });
  return { renderer, answers, sent, updated };
}

/** Feed a run through to completion with `text` as the final assistant turn. */
function runTo(renderer: ProgressRenderer, sessionId: string, text: string): void {
  renderer.handleEvent(sessionId, "C:/proj", { type: "agent_start" });
  renderer.handleEvent(sessionId, "C:/proj", {
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
  renderer.handleEvent(sessionId, "C:/proj", { type: "agent_settled" });
}

describe("answer extraction", () => {
  test("the full answer is handed to onAnswer, untruncated", () => {
    const { renderer, answers } = harness();
    // Comfortably past TAIL_CHARS (300): the card would clip this, the
    // answer must not be.
    const long = "结论：".repeat(400);

    runTo(renderer, "s1", long);

    expect(answers).toHaveLength(1);
    expect(answers[0].sessionId).toBe("s1");
    expect(answers[0].answer).toBe(long);
    renderer.dispose();
  });

  test("plain string content is handled as well as block arrays", () => {
    const { renderer, answers } = harness();
    renderer.handleEvent("s1", "C:/p", { type: "agent_start" });
    renderer.handleEvent("s1", "C:/p", {
      type: "agent_end",
      messages: [{ role: "assistant", content: "简短回答" }],
    });
    renderer.handleEvent("s1", "C:/p", { type: "agent_settled" });

    expect(answers[0]?.answer).toBe("简短回答");
    renderer.dispose();
  });

  test("a run with no assistant text reports no answer", () => {
    const { renderer, answers } = harness();
    renderer.handleEvent("s1", "C:/p", { type: "agent_start" });
    renderer.handleEvent("s1", "C:/p", { type: "agent_settled" });

    expect(answers).toEqual([]);
    renderer.dispose();
  });

  test("whitespace-only text is not delivered as an answer", () => {
    const { renderer, answers } = harness();
    runTo(renderer, "s1", "   \n  ");
    expect(answers).toEqual([]);
    renderer.dispose();
  });

  test("a second turn reports its own answer, not the previous one", () => {
    // Multi-turn: the follow-up must not re-deliver the first reply.
    const { renderer, answers } = harness();
    runTo(renderer, "s1", "第一轮答案");
    runTo(renderer, "s1", "第二轮答案");

    expect(answers.map((a) => a.answer)).toEqual(["第一轮答案", "第二轮答案"]);
    renderer.dispose();
  });

  test("a throwing onAnswer does not break the run", () => {
    const { conn } = fakeFeishu();
    const renderer = new ProgressRenderer(conn, {
      onAnswer: () => {
        throw new Error("boom");
      },
    });
    expect(() => runTo(renderer, "s1", "答案")).not.toThrow();
    renderer.dispose();
  });

  test("the last assistant message wins when several are present", () => {
    const { renderer, answers } = harness();
    renderer.handleEvent("s1", "C:/p", { type: "agent_start" });
    renderer.handleEvent("s1", "C:/p", {
      type: "agent_end",
      messages: [
        { role: "assistant", content: "早先的" },
        { role: "user", content: "中间的用户消息" },
        { role: "assistant", content: "最终的" },
      ],
    });
    renderer.handleEvent("s1", "C:/p", { type: "agent_settled" });

    expect(answers[0]?.answer).toBe("最终的");
    renderer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Card readability. The card is glanced at on a phone mid-run; these pin down
// that it reads as "what is it doing now" rather than as a call log.
// ---------------------------------------------------------------------------

/** Run the flush loop once and return the card body that would be sent. */
async function cardAfter(
  events: Array<Record<string, unknown>>,
): Promise<string> {
  const { conn, sent, updated } = fakeFeishu();
  const renderer = new ProgressRenderer(conn);
  for (const ev of events) renderer.handleEvent("s1", "C:/proj", ev);
  // The periodic flush is what actually renders the body.
  await new Promise((r) => setTimeout(r, 700));
  renderer.dispose();
  return updated.length ? updated[updated.length - 1].text : (sent[sent.length - 1] ?? "");
}

describe("card readability", () => {
  test("tool calls read as actions, not as function names", async () => {
    const body = await cardAfter([
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolName: "web_fetch",
        args: { url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,gold" },
      },
    ]);

    expect(body).toContain("抓取网页 api.coingecko.com");
    // The raw tool name and the query-string noise are gone.
    expect(body).not.toContain("web_fetch");
    expect(body).not.toContain("ids=bitcoin");
  });

  test("a shell command keeps the program and its target, not the flag soup", async () => {
    const body = await cardAfter([
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolName: "bash",
        args: {
          command:
            'curl -s --max-time 15 "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT" -H "User-Agent: x" | head -5',
        },
      },
    ]);

    expect(body).toContain("执行命令 curl api.binance.com");
    expect(body).not.toContain("--max-time");
    expect(body).not.toContain("User-Agent");
  });

  test("a quoted inline script is not mistaken for the command's target", async () => {
    // The `;` lives inside the quotes; splitting on it produced the
    // nonsensical "python datetime".
    const body = await cardAfter([
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: 'python -c "import datetime; print(datetime.datetime.now())"' },
      },
    ]);

    expect(body).toContain("· 执行命令 python");
    expect(body).not.toContain("datetime");
  });

  test("repeated identical steps collapse instead of stacking", async () => {
    const fetchTwo = {
      type: "tool_execution_start",
      toolName: "web_fetch",
      args: { url: "https://finance.sina.com.cn/" },
    };
    const body = await cardAfter([{ type: "agent_start" }, fetchTwo, fetchTwo, fetchTwo]);

    expect(body).toContain("x3");
    expect(body.match(/finance\.sina\.com\.cn/g)).toHaveLength(1);
  });

  test("the running note is one sentence, not a mashed-together window", async () => {
    // Reconstructs the reported card: several turns of thinking, newlines
    // collapsed, starting mid-word.
    const messy =
      "本状态和历史数据文件,再用其他新闻源。数据里有重要发现:BTC 数据抓取失败了。" +
      "并行抓取:外网抓取失败,试试国内可访问的源。新浪实时行情拿到了:纽约黄金 4639.7。";
    const body = await cardAfter([
      { type: "agent_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: messy } },
    ]);

    const note = body.split("\n").find((l) => l.startsWith("📝")) ?? "";
    expect(note).toBeTruthy();
    // One sentence, ending where a sentence ends.
    expect(note).toContain("新浪实时行情拿到了");
    expect(note).not.toContain("本状态和历史数据文件");
    expect(note.length).toBeLessThan(140);
  });

  test("the note disappears once the run is done, leaving the verdict", async () => {
    // The full answer goes out as its own message, so repeating a truncated
    // copy on the card is noise.
    const body = await cardAfter([
      { type: "agent_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "中间过程。" } },
      { type: "agent_end", messages: [{ role: "assistant", content: "最终结论。" }] },
      { type: "agent_settled" },
    ]);

    expect(body).toContain("✅ 完成");
    expect(body).not.toContain("📝");
  });

  test("an unknown tool degrades to its raw name rather than vanishing", async () => {
    const body = await cardAfter([
      { type: "agent_start" },
      { type: "tool_execution_start", toolName: "some_new_tool", args: {} },
    ]);
    expect(body).toContain("some_new_tool");
  });
});

describe("latestSentence", () => {
  test("returns the last finished sentence", () => {
    expect(latestSentence("前面的话。后面的话。", 100)).toBe("后面的话。");
  });

  test("prefers a finished sentence over a trailing fragment", () => {
    expect(latestSentence("完整的一句。写到一半", 100)).toBe("完整的一句。");
  });

  test("falls back to the fragment when nothing has finished", () => {
    expect(latestSentence("还没有写完的一句", 100)).toBe("还没有写完的一句");
  });

  test("collapses newlines so the card stays one line", () => {
    expect(latestSentence("第一行\n第二行", 100)).toBe("第一行 第二行");
  });

  test("caps a runaway sentence and keeps its freshest end", () => {
    const long = "长".repeat(300);
    const out = latestSentence(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.startsWith("…")).toBe(true);
  });

  test("empty input yields nothing to render", () => {
    expect(latestSentence("   ", 50)).toBe("");
  });
});
