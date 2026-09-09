import { useState } from "react";
import type { CompactionEntry } from "../lib/timeline";
import { MarkdownBlock } from "./AssistantMessage";

/**
 * Persistent bubble marking one context compaction.
 *
 * Unlike the transient running notice ("正在压缩上下文…"), a successful
 * compaction leaves this bubble in the transcript — also after the session is
 * reopened from its file (the Rust pager synthesizes compaction nodes back
 * into the message stream). Clicking the bubble expands the compaction
 * summary *downward* under it; clicking again collapses it.
 */
export default function CompactionBubble({ entry }: { entry: CompactionEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center py-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? "收起压缩摘要" : "展开压缩摘要"}
        className="flex items-center gap-1.5 rounded-full border border-dashed border-edge bg-card/60 px-3 py-1 text-xs text-dim transition-colors hover:bg-card hover:text-ink"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M8 3v10M4.5 6.5L8 3l3.5 3.5M4.5 9.5L8 13l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{entry.auto ? "上下文已自动压缩" : "上下文已压缩"}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M3.5 6.5L8 11l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mt-1.5 w-full max-w-2xl overflow-hidden rounded-xl border border-edge bg-card/40">
          <div className="max-h-[420px] overflow-y-auto px-3.5 py-2.5 text-sm leading-relaxed">
            <MarkdownBlock text={entry.summary} />
          </div>
        </div>
      )}
    </div>
  );
}
