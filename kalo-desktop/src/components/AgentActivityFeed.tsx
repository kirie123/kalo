import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  type AgentActivityItem,
  type CompactionActivityItem,
  compactionActivityView,
} from "../lib/subagent-activity";
import { CodeRenderer } from "./MarkdownBlock";

/**
 * One child agent's live activity feed: assistant texts, tool calls, and
 * compactions (doc/2026-09-18-子agent压缩气泡.md).
 *
 * Shared by the conversation's subagent card (ToolCallGroup) and the agent map
 * modal (AgentMapModal), which is why this lives in its own file rather than
 * inside either caller: the two must render the same feed the same way.
 */
export default function AgentActivityFeed({ activity }: { activity: AgentActivityItem[] }) {
  return (
    <div className="flex flex-col gap-1">
      {activity.map((item, i) =>
        item.kind === "tool" ? (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-3 shrink-0 text-center text-[11px]">
              {item.status === "running" ? (
                <span className="spinner" />
              ) : item.status === "error" ? (
                <span className="text-[var(--danger)]">✗</span>
              ) : (
                <span className="text-[var(--ok)]">✓</span>
              )}
            </span>
            <span className="shrink-0 text-dim">{item.name}</span>
            <span className="mono min-w-0 flex-1 truncate text-dim">{item.label}</span>
          </div>
        ) : item.kind === "compaction" ? (
          <CompactionActivityRow key={i} item={item} />
        ) : item.kind === "text" ? (
          <div key={i} className="markdown rounded-md border border-edge bg-card px-2.5 py-1.5 text-xs">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                code: CodeRenderer as any,
                pre: ({ children }) => <>{children}</>,
              }}
            >
              {item.text}
            </ReactMarkdown>
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * One compaction inside a subagent's activity feed.
 *
 * Children run their own auto-compaction (doc/2026-09-18-子agent压缩气泡.md), and
 * this card is the only place a user could notice it. Visual language follows
 * the main session's CompactionBubble: dashed pill, summary expands downward.
 */
function CompactionActivityRow({ item }: { item: CompactionActivityItem }) {
  const [open, setOpen] = useState(false);
  const view = compactionActivityView(item);
  const expandable = Boolean(item.summary);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-3 shrink-0 text-center text-[11px]">
          {item.status === "running" ? (
            <span className="spinner" />
          ) : item.status === "failed" ? (
            <span className="text-[var(--danger)]">✗</span>
          ) : (
            <span className="text-[var(--ok)]">✓</span>
          )}
        </span>
        <button
          type="button"
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          title={expandable ? (open ? "收起压缩摘要" : "展开压缩摘要") : undefined}
          onClick={() => setOpen((v) => !v)}
          className={`flex min-w-0 items-center gap-1.5 rounded-full border border-dashed border-edge bg-card/60 px-2.5 py-0.5 text-dim ${
            expandable ? "hover:bg-card hover:text-ink" : "cursor-default"
          }`}
        >
          <span className="truncate">{view.label}</span>
          {view.meta && <span className="mono shrink-0 text-[10px]">{view.meta}</span>}
          {expandable && (
            <svg
              width="9"
              height="9"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            >
              <path d="M3.5 6.5L8 11l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
      {open && item.summary && (
        <div className="markdown ml-5 rounded-md border border-edge bg-card px-2.5 py-1.5 text-xs">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              code: CodeRenderer as any,
              pre: ({ children }) => <>{children}</>,
            }}
          >
            {item.summary}
          </ReactMarkdown>
          {item.summaryTruncated && (
            <div className="mt-1 text-[10px] text-dim">摘要已截断，完整内容见子 agent 会话文件</div>
          )}
        </div>
      )}
    </div>
  );
}