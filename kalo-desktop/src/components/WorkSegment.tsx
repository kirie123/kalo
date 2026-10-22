import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { formatProcessDuration } from "../lib/conversation-turns";
import type { TimelineEntry } from "../lib/timeline";
import { toolChips } from "../lib/tool-labels";
import { sameSegmentEntries, type SegmentStats } from "../lib/work-segment";
import TimelineItem from "./TimelineItem";

/** A live run stays open. Once settled, only its process folds; results live outside. */
function WorkSegment({ entries, stats, running, startedAt, onScrollAdjust }: {
  entries: TimelineEntry[];
  stats: SegmentStats;
  running: boolean;
  startedAt?: number;
  onScrollAdjust?: (deltaY: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [finishedAt, setFinishedAt] = useState<number>();
  const open = running || expanded;
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorTop = useRef<number | null>(null);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (!running || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  useLayoutEffect(() => {
    if (wasRunning.current && !running) {
      setFinishedAt(Date.now());
    }
    if (running && !wasRunning.current) {
      setExpanded(false);
      setFinishedAt(undefined);
    }
    wasRunning.current = running;
    const root = rootRef.current;
    const top = anchorTop.current;
    anchorTop.current = null;
    if (root && top !== null) {
      const delta = root.getBoundingClientRect().top - top;
      if (delta !== 0) onScrollAdjust?.(delta);
    }
  });

  const toggle = () => {
    if (running) return;
    anchorTop.current = rootRef.current?.getBoundingClientRect().top ?? null;
    setExpanded((value) => !value);
  };
  const duration = startedAt !== undefined && (running || finishedAt !== undefined)
    ? formatProcessDuration((running ? now : finishedAt!) - startedAt) : undefined;
  const label = running ? `正在处理${duration ? ` ${duration}` : ""}` : duration ? `用时 ${duration}` : "工作过程";
  const summary = toolChips(stats.tools).map((chip) => chip.label).join("，");

  return (
    <section ref={rootRef} className={`work-segment ${running ? "is-running" : ""}`} aria-label="任务过程">
      <button
        type="button"
        onClick={toggle}
        disabled={running}
        aria-expanded={open}
        aria-controls={contentId}
        title={running ? "运行中持续展示进展" : summary || "展开查看处理过程"}
        className="work-segment-head"
      >
        <span>{label}</span>
        {stats.error && <span className="text-[var(--danger)]">含失败步骤</span>}
        {!running && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={open ? "rotate-90" : ""} aria-hidden="true"><path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        {running && <span className="spinner" aria-hidden="true" />}
      </button>
      {open && (
        <div id={contentId} className="work-segment-body">
          {entries.map((entry) => <TimelineItem key={entry.id} entry={entry} inSegment />)}
        </div>
      )}
    </section>
  );
}

export default memo(WorkSegment, (a, b) =>
  a.running === b.running && a.startedAt === b.startedAt && a.stats.error === b.stats.error
  && a.onScrollAdjust === b.onScrollAdjust && sameSegmentEntries(a.entries, b.entries));
