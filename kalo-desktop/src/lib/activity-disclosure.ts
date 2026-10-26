import { toolChips } from "./tool-labels";
import { formatProcessDuration } from "./conversation-turns";
import type { SegmentStats } from "./work-segment";

export interface ActivityDisclosure {
  running: boolean;
  open: boolean;
}

/** A phase change resets the default; updates within a phase respect the reader. */
export function syncActivityDisclosure(state: ActivityDisclosure, running: boolean): ActivityDisclosure {
  return state.running === running ? state : { running, open: running };
}

export function activitySummary(stats: SegmentStats): { label: string; full: string } {
  const labels = toolChips(stats.tools).map((chip) => chip.label);
  if (labels.length === 0) return { label: "思考过程", full: "思考过程" };
  return {
    label: labels.length > 3 ? `${labels.slice(0, 3).join("，")}等 ${labels.length} 类操作` : labels.join("，"),
    full: labels.join("，"),
  };
}

/** Missing history timing must never be replaced with time spent viewing it. */
export function activityHeading(stats: SegmentStats, running: boolean, elapsedMs?: number): string {
  const duration = elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? formatProcessDuration(elapsedMs) : undefined;
  if (!running) return duration ? `用时 ${duration}` : "任务过程";
  const summary = activitySummary(stats).label;
  return duration ? `${summary} · 已运行 ${duration}` : summary;
}
