import { describe, expect, test } from "bun:test";
import { deliverGatewayAnswer } from "./answer-delivery";

describe("gateway answer ownership", () => {
  test("scheduled answers are delivered in full, in ordered bounded chunks", async () => {
    const sent: string[] = [];
    const answer = "研究结果\n".repeat(2000);
    await deliverGatewayAnswer("schedule", answer, {
      isChat: () => false, isScheduled: () => true,
      chatAnswer: async () => { throw new Error("scheduled answer entered chat route"); },
      sendText: async (text) => { sent.push(text); },
    });
    expect(sent.join("")).toBe(answer);
    expect(sent.every((text) => text.length <= 3000)).toBe(true);
  });
  test("chat replies retain their existing channel handling", async () => {
    const received: string[] = [];
    await deliverGatewayAnswer("chat", "reply", {
      isChat: () => true, isScheduled: () => false,
      chatAnswer: async (id, text) => { received.push(id + ":" + text); },
      sendText: async () => { throw new Error("duplicate send"); },
    });
    expect(received).toEqual(["chat:reply"]);
  });
  test("desktop and removed scheduled sessions do not send messages", async () => {
    const received: string[] = [];
    await deliverGatewayAnswer("desktop", "private", {
      isChat: () => false, isScheduled: () => false,
      chatAnswer: async () => {}, sendText: async (text) => { received.push(text); },
    });
    expect(received).toEqual([]);
  });
});
