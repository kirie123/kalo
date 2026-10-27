import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { TimelineEntry } from "../lib/timeline";
import { buildUserMessageIndex, userMessageTicks } from "../lib/user-message-index";
import { useConversationNavigation } from "./useConversationNavigation";
import "../styles/conversation-navigation.css";

export default function ConversationNavigator({ timeline, scrollRef, contentRef, zoom, hasMore, loadingOlder, onLoadOlder, onNavigate }: {
  timeline: TimelineEntry[];
  scrollRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  zoom: number;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onNavigate: () => void;
}) {
  const items = useMemo(() => buildUserMessageIndex(timeline), [timeline]);
  const anchorKey = JSON.stringify(items.map((item) => item.id));
  const { activeId, jumpTo } = useConversationNavigation(scrollRef, contentRef, anchorKey, zoom, onNavigate);
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const ticks = userMessageTicks(items.length, activeIndex);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const suppressFocus = useRef(false);
  const panelId = useId();

  // Center the current item when opening; do not fight the reader's list scrolling.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (list && current) list.scrollTop = current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2;
  }, [open]);

  const dismiss = () => {
    suppressFocus.current = true;
    triggerRef.current?.focus({ preventScroll: true });
    suppressFocus.current = false;
    setOpen(false);
  };

  if (items.length < 2 && !hasMore) return null;
  return (
    <nav
      className="conversation-nav"
      aria-label="用户输入导航"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}
      onFocusCapture={() => { if (!suppressFocus.current) setOpen(true); }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="conversation-nav-rail"
        style={{ height: Math.min(360, ticks.length * 28 + 24) }}
        aria-label={`浏览用户输入（${items.length} 条已加载）`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(true)}
      >
        {ticks.length ? ticks.map((index) => <span key={index} className={`conversation-nav-tick ${index === activeIndex ? "is-active" : ""}`} />)
          : <span className="conversation-nav-tick" />}
      </button>
      {open && (
        <section id={panelId} className="conversation-nav-panel" aria-label="用户输入列表">
          <div ref={listRef} className="conversation-nav-list">
            {hasMore && <button type="button" className="conversation-nav-older" disabled={loadingOlder} onClick={onLoadOlder}>
              {loadingOlder ? "正在加载…" : "加载更早的输入"}
            </button>}
            {items.map((item) => (
              <button key={item.id} type="button" className="conversation-nav-item"
                aria-current={item.id === activeId ? "location" : undefined}
                title={item.label}
                onClick={() => { jumpTo(item.id); dismiss(); }}>
                <span>{item.label}</span><span className="conversation-nav-tick" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </nav>
  );
}
