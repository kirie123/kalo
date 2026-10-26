import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { activityHeading, activitySummary, syncActivityDisclosure } from "../lib/activity-disclosure";
import type { TimelineEntry } from "../lib/timeline";
import { sameSegmentEntries, type SegmentStats } from "../lib/work-segment";
import TimelineItem from "./TimelineItem";
import { ToolCallList } from "./ToolCallGroup";

/** Adjacent tools fold together; prose and deliverables remain in the transcript. */
function WorkSegment({ entries, stats, running, startedAt, onScrollAdjust }: {
  entries: TimelineEntry[];
  stats: SegmentStats;
  running: boolean;
  startedAt?: number;
  onScrollAdjust?: (deltaY: number) => void;
}) {
  const [disclosure, setDisclosure] = useState({ running, open: running });
  const [now, setNow] = useState(Date.now);
  const [finishedAt, setFinishedAt] = useState<number>();
  const current = syncActivityDisclosure(disclosure, running);
  const open = current.open;
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
    if (disclosure !== current) setDisclosure(current);
    if (wasRunning.current && !running) {
      setFinishedAt(Date.now());
    }
    if (running && !wasRunning.current) {
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
    anchorTop.current = rootRef.current?.getBoundingClientRect().top ?? null;
    setDisclosure({ running, open: !open });
  };
  const elapsedMs = startedAt !== undefined && Number.isFinite(startedAt) && startedAt > 0
    && (running || finishedAt !== undefined) ? (running ? now : finishedAt!) - startedAt : undefined;
  const summary = activitySummary(stats);
  const heading = activityHeading(stats, running, elapsedMs);

  return (
    <section ref={rootRef} className={`work-segment ${running ? "is-running" : ""}`} aria-label="任务过程">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={`${heading}${stats.error ? "，含失败步骤" : ""}`}
        title={summary.full}
        className="work-segment-head"
      >
        {running && <span className="activity-group-icon" aria-hidden="true"><span className="spinner" /></span>}
        <span className="activity-group-label">{heading}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`activity-group-chevron ${open ? "rotate-90" : ""}`} aria-hidden="true"><path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {stats.error && <span className="activity-group-error">含失败步骤</span>}
      </button>
      {open && (
        <div id={contentId} className="work-segment-body">
          {entries.map((entry) => entry.kind === "toolGroup"
            ? <div key={entry.id} className="activity-call-list"><ToolCallList calls={entry.calls} /></div>
            : <TimelineItem key={entry.id} entry={entry} inSegment />)}
        </div>
      )}
    </section>
  );
}

export default memo(WorkSegment, (a, b) =>
  a.running === b.running && a.startedAt === b.startedAt && a.stats.error === b.stats.error
  && a.onScrollAdjust === b.onScrollAdjust && sameSegmentEntries(a.entries, b.entries));
