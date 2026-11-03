import { parseAttachmentTag } from "../../lib/attachments";
import type { TimelineEntry } from "../../lib/timeline";

const MARKER = "【投行研究上下文】\n";
const REFRESH_AFTER = 8;
export type ContextDelivery = "first" | "changed" | "compacted" | "refresh" | "shared";

/** Only engine-received user messages count; a deletable queued input is not a receipt. */
export function contextDelivery(context: string, timeline: readonly TimelineEntry[]): ContextDelivery {
  let turns = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry.kind === "compaction" || (entry.kind === "notice" && entry.text === "上下文已压缩")) return "compacted";
    if (entry.kind !== "user") continue;
    const content = entry.message.content;
    const raw = typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const text = parseAttachmentTag(raw).text.trimEnd();
    const at = text.startsWith(MARKER) ? 0 : text.lastIndexOf(`\n\n${MARKER}`);
    if (at >= 0) {
      const previous = text.slice(at).trimStart();
      if (previous !== context.trim()) return "changed";
      return turns >= REFRESH_AFTER ? "refresh" : "shared";
    }
    turns++;
  }
  return "first";
}

export function lastUserId(timeline: readonly TimelineEntry[]): string {
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].kind === "user") return timeline[i].id;
  return "";
}
