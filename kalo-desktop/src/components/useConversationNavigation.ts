import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { activeUserMessageIndex } from "../lib/user-message-index";

/** DOM adapter: only the conversation scroller moves, never the page or side panel. */
export function useConversationNavigation(
  scrollRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
  anchorKey: string,
  zoom: number,
  onNavigate: () => void,
) {
  const [activeId, setActiveId] = useState<string>();

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let anchors: { id: string; top: number }[] = [];
    let frame = 0;
    let dirty = true;
    const update = () => {
      frame = 0;
      if (dirty) {
        const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
        anchors = Array.from(content.querySelectorAll<HTMLElement>("[data-user-message-id]"))
          .map((node) => ({ id: node.dataset.userMessageId!, top: node.getBoundingClientRect().top - origin }));
        dirty = false;
      }
      const index = activeUserMessageIndex(anchors.map((anchor) => anchor.top), scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight);
      setActiveId(anchors[index]?.id);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const measure = () => { dirty = true; schedule(); };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
    };
  }, [scrollRef, contentRef, anchorKey, zoom]);

  const jumpTo = useCallback((id: string) => {
    const scroll = scrollRef.current;
    const target = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-user-message-id]") ?? [])
      .find((node) => node.dataset.userMessageId === id);
    if (!scroll || !target) return;
    onNavigate();
    const top = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 16;
    scroll.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }, [scrollRef, contentRef, onNavigate]);

  return { activeId, jumpTo };
}
