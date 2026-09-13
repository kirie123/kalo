/**
 * 流式 assistant 消息的增量拼装（chat-store 只负责找到条目与触发刷新）。
 *
 * 引擎按 `contentIndex` 分块下发：`*_start` 建块、`*_delta` 追加、`*_end` 定稿。
 * 这里是纯函数——就地改写传入的 content 数组，不碰时间线、不碰 IPC，因此可以直接
 * 单测「一串事件拼出什么内容」。
 */

import type { AssistantMessage, AssistantMessageEvent, ToolCallContent } from "../types";

/** `*_delta` / `*_start` / `*_end` 这类带 contentIndex 的块事件。 */
type BlockEvent = Extract<AssistantMessageEvent, { contentIndex: number }>;

/** 事件是否是块级增量（false = done/error/start 这类整条消息的生命周期帧）。 */
export function isBlockEvent(ev: AssistantMessageEvent): ev is BlockEvent {
  return ev.type !== "done" && ev.type !== "error" && ev.type !== "start";
}

/** 就地把一个块事件应用到 content 数组上。 */
export function applyBlockEvent(content: any[], ev: BlockEvent): void {
  const i = ev.contentIndex;
  switch (ev.type) {
    case "text_start":
      content[i] = { type: "text", text: "" };
      break;
    case "text_delta": {
      const b = content[i];
      if (b?.type === "text") b.text += ev.delta;
      break;
    }
    case "text_end":
      content[i] = { type: "text", text: ev.content };
      break;
    case "thinking_start":
      content[i] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta": {
      const b = content[i];
      if (b?.type === "thinking") b.thinking += ev.delta;
      break;
    }
    case "thinking_end":
      // _done 标记该块已结束，这样它的转圈停下来，而同一条消息后面的块还能继续流。
      content[i] = { type: "thinking", thinking: ev.content, _done: true };
      break;
    case "toolcall_start":
      content[i] = { type: "toolCall", id: "", name: "", arguments: {}, _rawArgs: "" };
      break;
    case "toolcall_delta": {
      const b = content[i];
      if (b?.type === "toolCall") b._rawArgs = (b._rawArgs ?? "") + ev.delta;
      break;
    }
    case "toolcall_end":
      content[i] = ev.toolCall as ToolCallContent;
      break;
  }
}

/** 没见过 message_start 时，从事件自带的 partial 里播种一条消息。 */
export function seedMessage(ev: AssistantMessageEvent): AssistantMessage | undefined {
  const partial =
    "partial" in ev
      ? (ev.partial as AssistantMessage)
      : "message" in ev
        ? (ev as { message: AssistantMessage }).message
        : undefined;
  return partial ? { ...partial, content: [...partial.content] } : undefined;
}
