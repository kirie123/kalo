import { useEffect, useMemo, useState } from "react";
import { tickerEntries, trendClass } from "../lib/feed-view";
import { feedList, onFeedStatus } from "../lib/pi-bridge";
import type { FeedInfo } from "../types";

/**
 * Title-bar ticker: every enabled `surface: ticker` feed's items, scrolling
 * right-to-left (doc/2026-08-20-feeds-declarative-data-pull.md).
 *
 * Values come from the gateway's feed engine via `feed-status`; this component
 * never fetches anything itself. Hovering pauses the scroll and shows each
 * source's name and last pull time — which is also why the strip must NOT
 * carry `data-tauri-drag-region`: pausing needs pointer events, and Tauri's
 * drag region swallows them.
 */
export default function TickerBar({ onOpen }: { onOpen: () => void }) {
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);

  useEffect(() => {
    feedList()
      .then(setFeeds)
      .catch(() => {
        // No gateway (vite dev in a browser) — the strip stays empty.
      });
    const un = onFeedStatus(setFeeds);
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const entries = useMemo(() => tickerEntries(feeds), [feeds]);
  if (entries.length === 0) return null;

  // Duration scales with content so the speed stays constant regardless of
  // how many sources are enabled (~9s per item).
  const seconds = Math.max(12, entries.length * 9);

  return (
    <button
      onClick={onOpen}
      title="点击管理数据源"
      className="group relative mr-2 hidden h-8 min-w-0 max-w-[260px] cursor-pointer items-center overflow-hidden text-xs lg:flex"
    >
      <div
        className="ticker-track flex shrink-0 items-center whitespace-nowrap group-hover:[animation-play-state:paused]"
        style={{ animationDuration: `${seconds}s` }}
      >
        {/* Two identical copies; the animation shifts exactly one copy width
            (-50%), so the loop has no visible seam. The trailing pr-5 keeps the
            gap even across the wrap point. */}
        {[0, 1].map((copy) => (
          <div key={copy} className="flex items-center gap-5 pr-5" aria-hidden={copy === 1}>
            {entries.map((e, i) => (
              <span key={`${copy}-${i}`} title={e.detail} className={trendClass(e.trend)}>
                {e.text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </button>
  );
}
