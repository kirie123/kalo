/**
 * 输入队列（doc/2026-09-13-输入队列.md）的纯逻辑。
 *
 * 运行中回车的消息不再直接 steer 进当前轮，而是先落在桌面端的队列里：条目随时
 * 可删、可回填编辑、可手动「立即插入」。这里只放不碰 IPC/DOM 的部分，chat-store
 * 负责状态与投递编排。
 */

import { formatAttachmentTag } from "./attachments";
import type { AttachmentDraft, ImageContent } from "../types";

export interface QueuedInput {
  id: string;
  /** 用户敲的原文，不含 `<attachments>` 标签。 */
  text: string;
  /** 入队瞬间的附件快照：图片带 base64，文件带路径。 */
  attachments: AttachmentDraft[];
  createdAt: number;
}

let queueSeq = 1;

/** 组装一个队列条目；文本与附件都为空时返回 null（没什么可排队的）。 */
export function createQueuedInput(text: string, attachments: AttachmentDraft[]): QueuedInput | null {
  const typed = text.trim();
  if (!typed && attachments.length === 0) return null;
  return { id: `q-${queueSeq++}`, text: typed, attachments: [...attachments], createdAt: Date.now() };
}

/** 删除条目；id 不存在时原样返回（不制造新的数组身份）。 */
export function removeQueuedInput(queue: QueuedInput[], id: string): QueuedInput[] {
  return queue.some((q) => q.id === id) ? queue.filter((q) => q.id !== id) : queue;
}

/** 取出条目与剩余队列；id 不存在时 item 为 null。 */
export function takeQueuedInput(
  queue: QueuedInput[],
  id: string,
): { item: QueuedInput | null; rest: QueuedInput[] } {
  const item = queue.find((q) => q.id === id) ?? null;
  return { item, rest: item ? queue.filter((q) => q.id !== id) : queue };
}

/**
 * 这次回车该入队还是直接发？运行中（含压缩中）要排队；队列已经非空时也排队，
 * 否则后敲的消息会抢在前面，队列就不成其为队列了。
 */
export function shouldEnqueue(state: {
  isStreaming: boolean;
  isCompacting: boolean;
  queueLength: number;
}): boolean {
  return state.isStreaming || state.isCompacting || state.queueLength > 0;
}

/**
 * 文本 + 附件 → 引擎 prompt 的载荷。图片走 `images` 字段，其余文件只带路径（模型
 * 按需自己 read）。直接发送与队列投递共用它，避免两条路径拼出不同的消息。
 * 什么都没有时返回 null。
 */
export function buildPromptPayload(
  text: string,
  attachments: AttachmentDraft[],
): { message: string; images: ImageContent[] } | null {
  const images: ImageContent[] = [];
  const paths: string[] = [];
  for (const a of attachments) {
    if (a.kind === "image") images.push({ type: "image", data: a.dataBase64, mimeType: a.mimeType });
    else paths.push(a.path);
  }
  const typed = text.trim();
  const tag = formatAttachmentTag(paths);
  const message = tag ? (typed ? `${typed}\n\n${tag}` : tag) : typed;
  if (!message && images.length === 0) return null;
  return { message, images };
}

/** 条形控件上的一行预览：没有文本时退化成附件名。 */
export function queuedPreview(item: QueuedInput): string {
  const line = item.text.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (line) return line;
  const names = item.attachments.map((a) => a.name);
  return names.length > 0 ? names.join("、") : "（空消息）";
}
