import type { TimelineEntry } from "./timeline";
import { basename, parseAttachmentTag } from "./attachments";

export interface UserMessageIndexItem {
  id: string;
  label: string;
}

/** Read only user-authored text; attachment metadata and base64 never become labels. */
export function buildUserMessageIndex(timeline: TimelineEntry[]): UserMessageIndexItem[] {
  return timeline.flatMap((entry) => {
    if (entry.kind !== "user") return [];
    const content = entry.message.content;
    const raw = typeof content === "string" ? content
      : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const { text, paths } = parseAttachmentTag(raw);
    const images = typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
    const summary = text.replace(/\s+/g, " ").trim()
      || (paths.length ? `附件：${paths.map(basename).join("、")}` : images ? `${images} 张图片` : "空白输入");
    const chars = Array.from(summary);
    return [{ id: entry.id, label: chars.length > 96 ? `${chars.slice(0, 96).join("")}…` : summary }];
  });
}

/** Positions are scroll-content coordinates, including rendered CSS zoom. */
export function activeUserMessageIndex(tops: number[], scrollTop: number, viewportHeight: number, scrollHeight: number): number {
  if (!tops.length) return -1;
  if (scrollHeight > viewportHeight && scrollTop + viewportHeight >= scrollHeight - 2) return tops.length - 1;
  const readingLine = scrollTop + Math.min(96, viewportHeight * 0.25);
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] > readingLine) break;
    active = i;
  }
  return active;
}

/** Bound rail density while preserving the current input in its nearest slot. */
export function userMessageTicks(count: number, active: number): number[] {
  const size = Math.min(28, count);
  if (size <= 0) return [];
  if (size === 1) return [0];
  const ticks = Array.from({ length: size }, (_, i) => Math.round(i * (count - 1) / (size - 1)));
  if (active >= 0 && active < count) ticks[Math.round(active * (size - 1) / (count - 1))] = active;
  return ticks;
}
