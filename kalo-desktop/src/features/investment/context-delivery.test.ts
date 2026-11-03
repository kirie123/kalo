import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../lib/timeline";
import { formatAttachmentTag } from "../../lib/attachments";
import { researchContext } from "./code-logic";
import { contextDelivery, lastUserId } from "./context-delivery";

const a = researchContext("海康", { page: "code", datasetId: "a", draft: { source: "hold" } }).text;
const b = researchContext("海康", { page: "code", datasetId: "b", draft: { source: "buy" } }).text;
const user = (text: string, id = "u"): TimelineEntry => ({ id, kind: "user", message: { role: "user", content: text, timestamp: 0 } });
const injected = (context = a) => user(`分析此页\n\n${context}`);

describe("research context delivery", () => {
  it("injects on a new session and reuses received context on ordinary follow-ups", () => {
    expect(contextDelivery(a, [])).toBe("first");
    expect(contextDelivery(a, [injected(), user("为什么回撤这么高")])).toBe("shared");
    expect(contextDelivery(a, [user("发送失败后重试，没有已收到的上下文")])).toBe("first");
  });
  it("uses the most recent context, including returning from B to A", () => {
    expect(contextDelivery(b, [injected()])).toBe("changed");
    expect(contextDelivery(a, [injected(), injected(b)])).toBe("changed");
    expect(contextDelivery(a, [injected(b), injected()])).toBe("shared");
  });
  it("refreshes after eight follow-up user messages, not tool calls or notices", () => {
    const turns = Array.from({ length: 8 }, (_, i) => user(`追问${i}`, `u${i}`));
    const notices: TimelineEntry[] = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, kind: "notice", text: "运行中" }));
    expect(contextDelivery(a, [injected(), ...turns.slice(0, 7), ...notices])).toBe("shared");
    expect(contextDelivery(a, [injected(), ...turns])).toBe("refresh");
    expect(contextDelivery(a, [injected(), ...turns, injected()])).toBe("shared");
  });
  it("refreshes after successful compaction, including summary-less completion", () => {
    const compact: TimelineEntry = { id: "c", kind: "compaction", summary: "研究摘要", auto: true };
    expect(contextDelivery(a, [injected(), compact, user("继续")])).toBe("compacted");
    expect(contextDelivery(a, [compact, injected()])).toBe("shared");
    expect(contextDelivery(a, [injected(), { id: "c", kind: "notice", text: "上下文已压缩" }])).toBe("compacted");
    expect(contextDelivery(a, [injected(), { id: "c", kind: "notice", text: "上下文压缩已取消" }])).toBe("shared");
  });
  it("recognizes old injected messages with file paths and image content blocks", () => {
    const text = `请分析\n\n${a}\n\n${formatAttachmentTag(["C:/research/report.md"])}`;
    const entry: TimelineEntry = { id: "img", kind: "user", message: { role: "user", timestamp: 0, content: [{ type: "text", text }, { type: "image", data: "unused", mimeType: "image/png" }] } };
    expect(contextDelivery(a, [entry])).toBe("shared");
    expect(contextDelivery(a, [user(a)])).toBe("shared");
  });
  it("does not treat a mention of the marker or a different code draft as identical", () => {
    expect(contextDelivery(a, [user("解释【投行研究上下文】这个词")])).toBe("first");
    const edited = researchContext("海康", { page: "code", datasetId: "a", draft: { source: "buy" } }).text;
    expect(contextDelivery(edited, [injected()])).toBe("changed");
  });
  it("derives explicit re-attach anchors from this session's received user messages", () => {
    expect(lastUserId([])).toBe("");
    expect(lastUserId([user("第一次", "one"), { id: "notice", kind: "notice", text: "运行中" }])).toBe("one");
    expect(lastUserId([user("第一次", "one"), user("第二次", "two")])).toBe("two");
  });
});
