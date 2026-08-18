import { memo, useEffect, useMemo, useRef, useState } from "react";
import { chatStore, useChatSelector, type TimelineEntry } from "../lib/chat-store";
import { useChatZoom } from "../lib/chat-zoom";
import AssistantMessage, { assistantText } from "./AssistantMessage";
import ChangedFilesCard from "./ChangedFilesCard";
import RetryNotice from "./RetryNotice";
import ToolCallGroup from "./ToolCallGroup";
import UserBubble from "./UserBubble";

export default function MessageList() {
  const { timeline, history, loadingOlder, isStreaming, isCompacting } = useChatSelector((s) => ({
    timeline: s.timeline,
    history: s.history,
    loadingOlder: s.loadingOlder,
    isStreaming: s.isStreaming,
    isCompacting: s.isCompacting,
  }));
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoom = useChatZoom();
  // Stick to bottom unless the user scrolled up.
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Scroll height captured before an older-history prepend, to restore the viewport.
  const prependHeight = useRef<number | null>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distToBottom < 80;
    setShowJump(distToBottom > 200);
    if (el.scrollTop < 40 && history?.hasMore && !loadingOlder) {
      prependHeight.current = el.scrollHeight;
      void chatStore.loadOlderHistory();
    }
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  // After an older page is prepended, keep the viewport on the same message.
  useEffect(() => {
    const el = scrollRef.current;
    if (loadingOlder || !el || prependHeight.current === null) return;
    el.scrollTop += el.scrollHeight - prependHeight.current;
    prependHeight.current = null;
  }, [loadingOlder]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 px-4 py-4">
          {loadingOlder && <div className="text-center text-xs text-dim">加载更早的消息…</div>}
          {timeline.map((entry) => (
            <TimelineItem key={entry.id} entry={entry} />
          ))}
          {/* Working indicator while the agent is running but nothing visible yet */}
          {(isStreaming || isCompacting) && (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-dim">
              <span className="typing-dots">
                <span />
                <span />
                <span />
              </span>
              {isCompacting ? "正在压缩上下文" : "正在运行"}
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button
          onClick={jumpToBottom}
          title="回到最新"
          className="absolute bottom-4 right-4 rounded-full border border-edge bg-card p-2 text-dim shadow-lg hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

// Memoized: the store's throttled flush clones only mutated entries, so
// untouched timeline items skip re-rendering entirely during streaming.
const TimelineItem = memo(function TimelineItem({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case "user":
      return <UserBubble message={entry.message} />;
    case "assistant":
      return <AssistantMessage message={entry.message} streaming={entry.streaming} usage={entry.usage} />;
    case "toolGroup":
      return <ToolCallGroup toolName={entry.toolName} calls={entry.calls} />;
    case "retry":
      return (
        <RetryNotice
          attempt={entry.attempt}
          maxAttempts={entry.maxAttempts}
          delayMs={entry.delayMs}
          errorMessage={entry.errorMessage}
          done={entry.done}
        />
      );
    case "notice":
      return <div className="text-center text-xs text-dim">{entry.text}</div>;
  }
});
