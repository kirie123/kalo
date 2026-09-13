import { describe, expect, it } from "vitest";
import { applyBlockEvent, isBlockEvent } from "./assistant-stream";
import type { AssistantMessageEvent } from "../types";

const ev = (e: unknown) => e as Extract<AssistantMessageEvent, { contentIndex: number }>;

describe("isBlockEvent", () => {
  it("done/error/start 不是块事件", () => {
    expect(isBlockEvent({ type: "done" } as AssistantMessageEvent)).toBe(false);
    expect(isBlockEvent({ type: "error" } as AssistantMessageEvent)).toBe(false);
    expect(isBlockEvent({ type: "start" } as AssistantMessageEvent)).toBe(false);
  });

  it("text_delta 是块事件", () => {
    expect(isBlockEvent({ type: "text_delta", contentIndex: 0, delta: "a" } as AssistantMessageEvent)).toBe(true);
  });
});

describe("applyBlockEvent", () => {
  it("文本 delta 逐段累积，end 以权威内容定稿", () => {
    const content: any[] = [];
    applyBlockEvent(content, ev({ type: "text_start", contentIndex: 0 }));
    applyBlockEvent(content, ev({ type: "text_delta", contentIndex: 0, delta: "你" }));
    applyBlockEvent(content, ev({ type: "text_delta", contentIndex: 0, delta: "好" }));
    expect(content[0]).toEqual({ type: "text", text: "你好" });
    applyBlockEvent(content, ev({ type: "text_end", contentIndex: 0, content: "你好。" }));
    expect(content[0]).toEqual({ type: "text", text: "你好。" });
  });

  it("thinking_end 标记 _done，停掉这一块的转圈", () => {
    const content: any[] = [];
    applyBlockEvent(content, ev({ type: "thinking_start", contentIndex: 1 }));
    applyBlockEvent(content, ev({ type: "thinking_delta", contentIndex: 1, delta: "推" }));
    applyBlockEvent(content, ev({ type: "thinking_end", contentIndex: 1, content: "推理" }));
    expect(content[1]).toEqual({ type: "thinking", thinking: "推理", _done: true });
  });

  it("工具调用的参数以 _rawArgs 累积，end 用引擎给的结构替换", () => {
    const content: any[] = [];
    applyBlockEvent(content, ev({ type: "toolcall_start", contentIndex: 0 }));
    applyBlockEvent(content, ev({ type: "toolcall_delta", contentIndex: 0, delta: '{"a"' }));
    applyBlockEvent(content, ev({ type: "toolcall_delta", contentIndex: 0, delta: ":1}" }));
    expect(content[0]._rawArgs).toBe('{"a":1}');
    applyBlockEvent(content, ev({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { a: 1 } } }));
    expect(content[0]).toEqual({ type: "toolCall", id: "t1", name: "read", arguments: { a: 1 } });
  });

  it("块类型对不上的 delta 被忽略，不会污染内容", () => {
    const content: any[] = [{ type: "text", text: "hi" }];
    applyBlockEvent(content, ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    expect(content[0]).toEqual({ type: "text", text: "hi" });
  });
});
