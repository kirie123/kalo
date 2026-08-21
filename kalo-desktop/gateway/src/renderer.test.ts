/**
 * Renderer tests, focused on the answer-extraction path.
 *
 * The progress card is a truncated, overwritten-in-place live view; the final
 * answer has to escape it intact. That extraction (agent_end captures the full
 * text, agent_settled hands it to onAnswer) is what these tests pin down.
 */

import { describe, expect, test } from "bun:test";
import { ProgressRenderer } from "./renderer";
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
