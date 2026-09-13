import { describe, expect, it } from "vitest";
import {
  buildPromptPayload,
  createQueuedInput,
  queuedPreview,
  removeQueuedInput,
  shouldEnqueue,
  takeQueuedInput,
} from "./input-queue";
import type { AttachmentDraft } from "../types";

const img: AttachmentDraft = { kind: "image", name: "a.png", mimeType: "image/png", dataBase64: "AAA" };
const doc: AttachmentDraft = { kind: "file", name: "报告.pdf", path: "D:/x/报告.pdf" };

describe("createQueuedInput", () => {
  it("空文本且无附件时不入队", () => {
    expect(createQueuedInput("   \n ", [])).toBeNull();
  });

  it("只有附件也能入队，文本被 trim", () => {
    const item = createQueuedInput("  跑一下  ", [doc]);
    expect(item?.text).toBe("跑一下");
    expect(item?.attachments).toEqual([doc]);
  });

  it("快照附件数组，后续修改原数组不影响条目", () => {
    const drafts: AttachmentDraft[] = [doc];
    const item = createQueuedInput("", drafts)!;
    drafts.push(img);
    expect(item.attachments).toHaveLength(1);
  });

  it("条目 id 互不相同", () => {
    const a = createQueuedInput("a", [])!;
    const b = createQueuedInput("b", [])!;
    expect(a.id).not.toBe(b.id);
  });
});

describe("removeQueuedInput / takeQueuedInput", () => {
  const a = createQueuedInput("a", [])!;
  const b = createQueuedInput("b", [])!;

  it("按 id 删除", () => {
    expect(removeQueuedInput([a, b], a.id)).toEqual([b]);
  });

  it("id 不存在时返回同一个数组引用", () => {
    const queue = [a, b];
    expect(removeQueuedInput(queue, "nope")).toBe(queue);
  });

  it("取出条目并返回剩余队列", () => {
    const { item, rest } = takeQueuedInput([a, b], b.id);
    expect(item).toBe(b);
    expect(rest).toEqual([a]);
  });

  it("取不到时 item 为 null，队列不变", () => {
    const queue = [a];
    const { item, rest } = takeQueuedInput(queue, "nope");
    expect(item).toBeNull();
    expect(rest).toBe(queue);
  });
});

describe("shouldEnqueue", () => {
  it("空闲且队列为空时直接发送", () => {
    expect(shouldEnqueue({ isStreaming: false, isCompacting: false, queueLength: 0 })).toBe(false);
  });

  it("运行中要排队", () => {
    expect(shouldEnqueue({ isStreaming: true, isCompacting: false, queueLength: 0 })).toBe(true);
  });

  it("压缩中要排队", () => {
    expect(shouldEnqueue({ isStreaming: false, isCompacting: true, queueLength: 0 })).toBe(true);
  });

  it("队列非空时保序，继续排队", () => {
    expect(shouldEnqueue({ isStreaming: false, isCompacting: false, queueLength: 1 })).toBe(true);
  });
});

describe("buildPromptPayload", () => {
  it("图片进 images，文件进 attachments 标签", () => {
    const p = buildPromptPayload("看看这个", [img, doc])!;
    expect(p.images).toEqual([{ type: "image", data: "AAA", mimeType: "image/png" }]);
    expect(p.message).toContain("看看这个");
    expect(p.message).toContain('<file path="D:/x/报告.pdf" />');
  });

  it("无附件时消息就是原文", () => {
    expect(buildPromptPayload("你好", [])).toEqual({ message: "你好", images: [] });
  });

  it("只有文件时消息只剩标签", () => {
    const p = buildPromptPayload("", [doc])!;
    expect(p.message.startsWith("<attachments>")).toBe(true);
  });

  it("只有图片时消息为空但仍可发送", () => {
    const p = buildPromptPayload("", [img])!;
    expect(p.message).toBe("");
    expect(p.images).toHaveLength(1);
  });

  it("什么都没有时返回 null", () => {
    expect(buildPromptPayload("  ", [])).toBeNull();
  });
});

describe("queuedPreview", () => {
  it("取第一行非空文本", () => {
    const item = createQueuedInput("\n第一行\n第二行", [])!;
    expect(queuedPreview(item)).toBe("第一行");
  });

  it("无文本时退化为附件名", () => {
    const item = createQueuedInput("", [img, doc])!;
    expect(queuedPreview(item)).toBe("a.png、报告.pdf");
  });
});
