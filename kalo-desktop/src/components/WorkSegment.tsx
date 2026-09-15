import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TimelineEntry } from "../lib/timeline";
import { groupTitle } from "../lib/tool-labels";
import { sameSegmentEntries, type SegmentStats } from "../lib/work-segment";
import TimelineItem from "./TimelineItem";

/**
 * Parent bubble over one run of consecutive process entries (thinking blocks +
 * tool groups + retry notices). Collapsed it is a single summary line;
 * expanded it renders exactly the rows it always did, behind a sticky header
 * (doc/2026-09-13-工作段母气泡.md).
 *
 * Open state: `autoOpen` drives it (running run expanded, settled run folded)
 * until the user clicks, after which their choice wins for the life of this
 * segment. Entry ids are per-loaded-timeline, so switching sessions remounts
 * segments and replayed history comes back folded.
 */
function WorkSegment({
  entries,
  stats,
  autoOpen,
  onScrollAdjust,
}: {
  entries: TimelineEntry[];
  stats: SegmentStats;
  autoOpen: boolean;
  /** Keeps the header pinned in the viewport when collapsing shortens the page. */
  onScrollAdjust?: (deltaY: number) => void;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? autoOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorTop = useRef<number | null>(null);

  useLayoutEffect(() => {
    const top = anchorTop.current;
    anchorTop.current = null;
    if (top === null || !rootRef.current) return;
    const delta = rootRef.current.getBoundingClientRect().top - top;
    if (delta !== 0) onScrollAdjust?.(delta);
  }, [open, onScrollAdjust]);

  const toggle = () => {
    anchorTop.current = rootRef.current?.getBoundingClientRect().top ?? null;
    setManual(!open);
  };

  const state = stats.running ? "running" : stats.error ? "error" : "done";

  return (
    <div
      ref={rootRef}
      className={`work-segment my-0.5 text-[13px] ${stats.running ? "is-running" : ""} ${open ? "bg-card" : ""}`}
    >
      <button
        onClick={toggle}
        className={`work-segment-head flex w-full items-center gap-2.5 px-3 py-2 text-left ${
          open ? "sticky top-0 z-[5] rounded-t-[10px] border-b border-edge bg-card" : "rounded-[10px]"
        }`}
      >
        <span
          className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-xs ${
            state === "running"
              ? "bg-tone-blue-soft text-tone-blue"
              : state === "error"
                ? "text-[var(--danger)]"
                : "text-[var(--ok)]"
          }`}
        >
          {state === "running" ? <span className="spinner" /> : state === "error" ? "✗" : "✓"}
        </span>
        <span className={`shrink-0 font-medium ${state === "running" ? "text-tone-blue" : ""}`}>
          {headline(stats)}
        </span>
        <span className="flex min-w-0 flex-wrap gap-1.5">
          {stats.thoughts > 0 && <Stat>{stats.thoughts} 次思考</Stat>}
          {stats.tools.map((t) => (
            <Stat key={t.name}>{groupTitle(t.name, t.count)}</Stat>
          ))}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={`ml-auto shrink-0 text-dim transition-transform ${open ? "" : "-rotate-90"}`}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {!open && stats.lastLabel && (
        <button onClick={toggle} className="block w-full pb-2 pl-[46px] pr-3 text-left">
          <span className="mono block truncate text-[11.5px] text-dim">
            {stats.running ? "正在 " : "最后一步："}
            {stats.lastLabel}
          </span>
        </button>
      )}

      {open && (
        <div className="py-1 pl-4 pr-2.5">
          <div className="flex flex-col border-l border-edge pl-2">
            {entries.map((entry) => (
              <TimelineItem key={entry.id} entry={entry} />
            ))}
          </div>
          <button onClick={toggle} className="mt-1 pl-1 text-left text-[11px] text-dim hover:text-ink">
            收起这 {entries.length} 条过程 ⌃
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ children }: { children: ReactNode }) {
  return (
    <span className="work-segment-stat whitespace-nowrap rounded px-[7px] py-0.5 text-[11px] text-dim">
      {children}
    </span>
  );
}

function headline(stats: SegmentStats): string {
  if (stats.running) return `正在工作 · 第 ${stats.steps} 步`;
  if (stats.thoughts > 0) return `思考并执行 ${stats.steps} 步`;
  return `执行 ${stats.steps} 步`;
}

// The store flushes ~20×/s while streaming but clones only mutated entries, so
// an element-wise reference check keeps settled segments out of the render pass.
export default memo(
  WorkSegment,
  (a, b) =>
    a.autoOpen === b.autoOpen &&
    a.stats.steps === b.stats.steps &&
    a.stats.running === b.stats.running &&
    a.stats.error === b.stats.error &&
    a.stats.lastLabel === b.stats.lastLabel &&
    a.onScrollAdjust === b.onScrollAdjust &&
    sameSegmentEntries(a.entries, b.entries),
);
