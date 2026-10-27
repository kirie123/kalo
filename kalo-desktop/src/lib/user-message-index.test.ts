import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "./timeline";
import type { UserMessage } from "../types";
import { formatAttachmentTag } from "./attachments";
import { activeUserMessageIndex, buildUserMessageIndex, userMessageTicks } from "./user-message-index";

const user = (id: string, content: UserMessage["content"]): TimelineEntry => ({
  id, kind: "user", message: { role: "user", content, timestamp: 1 },
});

describe("user message index", () => {
  it("keeps repeated prompts independently navigable and excludes assistant activity", () => {
    const timeline: TimelineEntry[] = [user("a", "继续"), { id: "notice", kind: "notice", text: "稍后重试" },
      { id: "answer", kind: "assistant", streaming: false, message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "回答" }] } },
      user("b", "继续")];
    const source = structuredClone(timeline);
    expect(buildUserMessageIndex(timeline)).toEqual([{ id: "a", label: "继续" }, { id: "b", label: "继续" }]);
    expect(timeline).toEqual(source);
  });
  it("normalizes whitespace and joins text blocks without exposing image data", () => {
    expect(buildUserMessageIndex([user("a", [{ type: "text", text: "  请分析\n\n" },
      { type: "image", data: "private-base64", mimeType: "image/png" }, { type: "text", text: "\t这张图  " }])]))
      .toEqual([{ id: "a", label: "请分析 这张图" }]);
  });
  it("uses meaningful labels for image-only, file-only and empty prompts on both platforms", () => {
    const items = buildUserMessageIndex([
      user("image", [{ type: "image", data: "private-base64", mimeType: "image/png" }]),
      user("files", formatAttachmentTag(["C:\\files\\报告.pdf", "/tmp/data.csv"])), user("empty", " \n"),
      user("text", `检查这些文件\n\n${formatAttachmentTag(["C:\\files\\report.pdf"])}`),
    ]);
    expect(items.map((item) => item.label)).toEqual(["1 张图片", "附件：报告.pdf、data.csv", "空白输入", "检查这些文件"]);
  });
  it("bounds long previews without cutting Unicode characters or changing source text", () => {
    const text = "🚀".repeat(100);
    expect(buildUserMessageIndex([user("long", text)])[0].label).toBe(`${"🚀".repeat(96)}…`);
  });
});

describe("reading position", () => {
  it("tracks the owning user input through long assistant replies", () => {
    expect(activeUserMessageIndex([20, 400, 1200], 0, 500, 2000)).toBe(0);
    expect(activeUserMessageIndex([20, 400, 1200], 450, 500, 2000)).toBe(1);
    expect(activeUserMessageIndex([20, 400, 1200], 1000, 500, 2000)).toBe(1);
    expect(activeUserMessageIndex([20, 400, 1200], 1150, 500, 2000)).toBe(2);
  });
  it("handles empty history, content fitting the viewport and the very bottom", () => {
    expect(activeUserMessageIndex([], 0, 500, 500)).toBe(-1);
    expect(activeUserMessageIndex([20, 300], 0, 500, 500)).toBe(0);
    expect(activeUserMessageIndex([20, 1800], 1500, 500, 2000)).toBe(1);
  });
  it("keeps the same active message after older history is prepended", () => {
    expect(activeUserMessageIndex([20, 600], 650, 500, 2000)).toBe(1);
    expect(activeUserMessageIndex([20, 1020, 1600], 1650, 500, 3000)).toBe(2);
  });
});

describe("navigation tick density", () => {
  it("retains every message in short conversations", () => {
    expect(userMessageTicks(0, -1)).toEqual([]);
    expect(userMessageTicks(1, 0)).toEqual([0]);
    expect(userMessageTicks(4, 2)).toEqual([0, 1, 2, 3]);
  });
  it("keeps the active message in an ordered, bounded rail for long histories", () => {
    for (const active of [0, 1, 37, 83, 198, 199]) {
      const ticks = userMessageTicks(200, active);
      expect(ticks).toContain(active);
      expect(ticks.length).toBeLessThanOrEqual(28);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
      expect(ticks.every((index) => index >= 0 && index < 200)).toBe(true);
    }
  });
});
