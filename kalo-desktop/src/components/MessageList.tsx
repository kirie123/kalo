import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatStore, useChatSelector } from "../lib/chat-store";
import type { TimelineEntry } from "../lib/timeline";
import { useChatZoom } from "../lib/chat-zoom";
import { foldWorkSegments } from "../lib/work-segment";
import { assistantText } from "./AssistantMessage";
import TimelineItem from "./TimelineItem";
import WorkSegment from "./WorkSegment";

export default function MessageList() {
  const { timeline, history, loadingOlder, isStreaming, isCompacting, activeSessionKey } = useChatSelector(
    (s) => ({
      timeline: s.timeline,
      history: s.history,
      loadingOlder: s.loadingOlder,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      activeSessionKey: s.activeSessionKey,
    }),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoom = useChatZoom();
  // Stick to bottom unless the user scrolled up.
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Scroll height captured before an older-history prepend, to restore the viewport.
  const prependHeight = useRef<number | null>(null);

  // One copy button per turn, on the turn's last assistant message, carrying the
  // turn's full text. A turn ends at the next user message; the trailing turn
  // only qualifies once the run has settled.
  const turnCopyText = useMemo(() => buildTurnCopyText(timeline, isStreaming || isCompacting), [
    timeline,
    isStreaming,
    isCompacting,
  ]);

  // Consecutive thinking/tool entries render under one collapsible parent
  // bubble. Pure view-layer fold: the timeline itself (live or replayed from a
  // session file) is untouched (doc/2026-09-13-工作段母气泡.md).
  const rows = useMemo(() => foldWorkSegments(timeline), [timeline]);

  // Collapsing a segment above the viewport shortens the page; keep the header
  // where the user clicked it (same trick as the older-history prepend).
  const adjustScroll = useCallback((deltaY: number) => {
    const el = scrollRef.current;
    if (el) el.scrollTop += deltaY;
  }, []);

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
  }, [timeline, zoom]);

  // Switching sessions always lands on the newest message: the stick-to-bottom
  // flag is per-view, so without this reset a session left scrolled up would
  // pin the next session's timeline mid-history. Layout for the incoming
  // timeline is not measured yet on this pass, so the jump is deferred a frame
  // (and repeated once more for late-measuring content such as images).
  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    prependHeight.current = null;
    let second = 0;
    const first = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      second = requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2 && stickToBottom.current) el2.scrollTop = el2.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [activeSessionKey]);

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
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 px-4 py-4" style={{ zoom }}>
          {loadingOlder && <div className="text-center text-xs text-dim">加载更早的消息…</div>}
          {rows.map((row, i) =>
            row.kind === "segment" ? (
              <WorkSegment
                key={row.id}
                entries={row.entries}
                stats={row.stats}
                // Follow the agent live: the running segment (and the trailing
                // one of a run that hasn't settled) starts expanded, then folds
                // itself once the run ends.
                autoOpen={row.stats.running || (i === rows.length - 1 && (isStreaming || isCompacting))}
                onScrollAdjust={adjustScroll}
              />
            ) : (
              <TimelineItem
                key={row.entry.id}
                entry={row.entry}
                copyText={turnCopyText.get(row.entry.id)}
              />
            ),
          )}
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

/**
 * Maps the id of each turn's last assistant entry to the markdown of every
 * assistant text block in that turn. Entries not in the map render no copy
 * button. `running` suppresses the trailing turn, which isn't finished yet.
 */
function buildTurnCopyText(timeline: TimelineEntry[], running: boolean): Map<string, string> {
  const map = new Map<string, string>();
  let parts: string[] = [];
  let lastId: string | null = null;

  const flush = () => {
    if (lastId && parts.length > 0) map.set(lastId, parts.join("\n\n"));
    parts = [];
    lastId = null;
  };

  for (const entry of timeline) {
    if (entry.kind === "user") flush();
    else if (entry.kind === "assistant") {
      const text = assistantText(entry.message);
      // Only messages with prose can carry the button: a thinking-only trailing
      // message lives inside a folded work segment, where the button would hide.
      if (text) {
        parts.push(text);
        lastId = entry.id;
      }
    }
  }
  if (!running) flush();
  return map;
}

