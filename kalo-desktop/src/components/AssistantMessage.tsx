import hljs from "highlight.js";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatApiError } from "../lib/error-format";
import type { AssistantMessage as AssistantMessageType } from "../types";
import ThinkingBlock from "./ThinkingBlock";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Code renderer: inline code vs fenced block (highlight.js for blocks). */
function CodeRenderer({ className, children }: { className?: string; children?: ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
  const isInline = !lang && !code.includes("\n");
  if (isInline) return <code className="md-inline-code">{code}</code>;

  let html: string;
  try {
    html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
  } catch {
    html = escapeHtml(code);
  }
  return (
    <div className="md-codeblock">
      {lang && <div className="md-codeblock-lang">{lang}</div>}
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export default function AssistantMessage({
  message,
  streaming,
}: {
  message: AssistantMessageType;
  streaming?: boolean;
}) {
  const failed = message.stopReason === "error" && message.errorMessage;
  const lastIdx = message.content.length - 1;
  return (
    <div className={`text-sm ${streaming ? "streaming-cursor" : ""}`}>
      {message.content.map((block, i) => {
        if (block.type === "text") {
          if (!block.text && !streaming) return null;
          return (
            <div key={i} className="markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: CodeRenderer as any,
                  // CodeRenderer renders its own <pre>; avoid a double wrapper.
                  pre: ({ children }) => <>{children}</>,
                }}
              >
                {block.text}
              </ReactMarkdown>
            </div>
          );
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
    </div>
  );
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
