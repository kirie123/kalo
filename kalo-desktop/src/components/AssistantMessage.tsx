import { useState } from "react";
import { formatApiError, isAbortError } from "../lib/error-format";
import type { AssistantMessage as AssistantMessageType } from "../types";
import { formatRunUsage } from "../lib/run-usage";
import CopyButton from "./CopyButton";
import InterruptDivider from "./InterruptDivider";
import StreamingText from "./StreamingText";
import ThinkingBlock from "./ThinkingBlock";
import type { TurnUsage } from "../lib/timeline";

/** Code renderer, markdown pipeline and the markdown text block live in
 *  MarkdownBlock.tsx (extracted so StreamingText can share them without an
 *  import cycle): see doc/2026-10-01-高负载下界面响应与输入可见性.md §3. */

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
  // (doc/2026-09-10-打断提示波浪分割线.md). An abort during a tool call
  // arrives as stopReason "error" carrying the AbortError text, so the message
  // has to be inspected too — same user action, same divider.
  const interrupted = message.stopReason === "aborted" || isAbortError(message.errorMessage);
  const failed = !interrupted && message.stopReason === "error" && message.errorMessage && !errorRetried;
  const lastIdx = message.content.length - 1;
  return (
    <div className={`text-sm ${streaming ? "streaming-cursor" : ""}`}>
      {message.content.map((block, i) => {
        if (block.type === "text") {
          if (!block.text && !streaming) return null;
          return <StreamingText key={i} text={block.text} streaming={Boolean(streaming) && i === lastIdx} />;
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
        <div className="group/msg mt-2 flex items-end justify-between gap-2 text-[11px] text-dim">
          <span>
            {usage && formatRunUsage(usage)}
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
