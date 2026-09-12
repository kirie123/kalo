import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { formatApiError } from "../lib/error-format";
import { highlight } from "../lib/highlight";
import { htmlToMarkdown } from "../lib/html-downgrade";
import { splitSvgSegments } from "../lib/svg-render";
import type { AssistantMessage as AssistantMessageType } from "../types";
import { formatK } from "./ContextRing";
import CopyButton from "./CopyButton";
import InterruptDivider from "./InterruptDivider";
import SvgBlock from "./SvgBlock";
import ThinkingBlock from "./ThinkingBlock";
import type { TurnUsage } from "../lib/timeline";

/** Code renderer: inline code vs fenced block (highlight.js for blocks). */
export function CodeRenderer({ className, children }: { className?: string; children?: ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
  const isInline = !lang && !code.includes("\n");
  if (isInline) return <code className="md-inline-code">{code}</code>;

  // ```svg draws the figure; the source stays one toggle away.
  if (lang === "svg") return <SvgBlock source={code} />;

  const html = highlight(code, lang);
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span className="md-codeblock-lang">{lang ?? ""}</span>
        <CopyButton text={code} title="复制代码" />
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/**
 * One markdown text block, memoized on its source text: while the last block
 * of a streaming message grows, the earlier (finished) blocks skip remark/
 * rehype parsing entirely.
 *
 * Inline `<svg>…</svg>` spans are carved out first and drawn as figures, and
 * whitelisted HTML (`<h3>`, `<br>`, `<table>`…) is rewritten as markdown. We
 * deliberately do not enable rehype-raw: no raw HTML is ever executed
 * (doc/2026-09-12-对话区svg渲染.md).
 *
 * Exported because the file preview renders markdown files through the same
 * pipeline — a `.md` file and the agent's prose should look identical.
 */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const segments = splitSvgSegments(text);
  return (
    <div className="markdown">
      {segments.map((segment, i) =>
        segment.type === "svg" ? (
          <SvgBlock key={i} source={segment.source} complete={segment.complete} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              code: CodeRenderer as any,
              // CodeRenderer renders its own <pre>; avoid a double wrapper.
              pre: ({ children }) => <>{children}</>,
            }}
          >
            {htmlToMarkdown(segment.text)}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
});

export default function AssistantMessage({
  message,
  streaming,
  usage,
  copyText,
  errorRetried,
}: {
  message: AssistantMessageType;
  streaming?: boolean;
  usage?: TurnUsage;
  /**
   * Markdown of the whole turn, set only on the turn's last assistant message.
   * When absent no copy button is rendered — one button per turn, not per bubble.
   */
  copyText?: string;
  /** Error already shown by the retry notice; don't render a second banner. */
  errorRetried?: boolean;
}) {
  // Stopping a run is a deliberate act, not a failure: mark it with the wave
  // divider and swallow the engine's raw "Request was aborted" instead of
  // dropping a red error block into the transcript
  // (doc/2026-09-10-打断提示波浪分割线.md).
  const interrupted = message.stopReason === "aborted";
  const failed = !interrupted && message.stopReason === "error" && message.errorMessage && !errorRetried;
  const lastIdx = message.content.length - 1;
  // Cache hit rate = cache reads over all input-side tokens (fresh + cached).
  const inputSide = usage ? usage.input + usage.cacheRead : 0;
  const hitRate = usage && inputSide > 0 ? Math.round((usage.cacheRead / inputSide) * 100) : null;
  return (
    <div className={`text-sm ${streaming ? "streaming-cursor" : ""}`}>
      {message.content.map((block, i) => {
        if (block.type === "text") {
          if (!block.text && !streaming) return null;
          return <MarkdownBlock key={i} text={block.text} />;
        }
        if (block.type === "thinking") {
          // Spinner only while this block is the one currently streaming;
          // thinking_end marks it _done so it stops even if the message continues.
          const done = (block as { _done?: boolean })._done === true;
          return <ThinkingBlock key={i} thinking={block.thinking} live={streaming && i === lastIdx && !done} />;
        }
        // toolCall blocks are rendered via ToolCallGroup (tool execution events)
        return null;
      })}
      {failed && <ErrorBanner raw={message.errorMessage!} />}
      {interrupted && <InterruptDivider />}
      {!streaming && (usage || copyText) && (
        <div className="group/msg mt-2 flex items-end justify-between gap-2 text-xs text-dim">
          <span>
            {usage &&
              `本轮 tokens：输入 ${formatK(inputSide)} · 输出 ${formatK(usage.output)}${
                hitRate !== null ? ` · 缓存命中 ${hitRate}%` : ""
              }`}
          </span>
          {copyText && (
            <span className="opacity-0 transition-opacity group-hover/msg:opacity-100">
              <CopyButton text={copyText} title="复制本轮回复" />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Markdown source of all text blocks, joined with a blank line. */
export function assistantText(message: AssistantMessageType): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/** Clean one-line error summary with the raw payload expandable. */
function ErrorBanner({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  const parsed = formatApiError(raw);
  return (
    <div className="mt-2 rounded-md border border-[var(--error-border)] bg-[var(--error-bg)] px-3 py-2 text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[var(--danger)]"
      >
        <span className="min-w-0 flex-1">{parsed.summary}</span>
        {parsed.detail && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`shrink-0 opacity-60 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open && parsed.detail && (
        <pre className="mono mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-[var(--error-border)] bg-base p-2 text-xs text-dim">
          {parsed.detail}
        </pre>
      )}
    </div>
  );
}
