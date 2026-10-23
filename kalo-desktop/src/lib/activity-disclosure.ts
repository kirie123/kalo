import { toolChips } from "./tool-labels";
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
