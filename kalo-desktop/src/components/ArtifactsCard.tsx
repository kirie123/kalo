import { useState } from "react";
import type { ArtifactSummary } from "../lib/artifacts";
import ArtifactList, { DeliverableIcon } from "./ArtifactList";

/**
 * The inline card rendered in the timeline for one present_files call.
 *
 * Only a fallback these days: when the call belongs to a run that also touched
 * files, foldRunArtifacts absorbs its list into that run's end-of-run card
 * instead (doc/2026-09-28-产物呈现通道.md § 2026-10-11 增补). This card is
 * what history replay shows, and where a run with deliverables but no file
 * changes lands.
 */
export default function ArtifactsCard({ summary }: { summary: ArtifactSummary }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="my-1 rounded-lg border border-edge bg-card text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-base"
      >
        <DeliverableIcon />
        <span className="font-medium text-ink">产物 {summary.items.length} 个</span>
        {summary.explanation && (
          <span className="min-w-0 flex-1 truncate text-xs text-dim">{summary.explanation}</span>
        )}
        <svg
          width="10"
          height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={`shrink-0 text-dim transition-transform ${open ? "" : "-rotate-90"}`}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-edge px-0.5 py-1">
          <ArtifactList items={summary.items} />
        </div>
      )}
    </div>
  );
}