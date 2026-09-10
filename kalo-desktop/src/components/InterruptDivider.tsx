/**
 * The mark a user interruption leaves in the transcript.
 *
 * Stopping a run is a normal state change, not a failure, so it is drawn in
 * the same restrained greys as the compaction bubble (dim text on the --edge
 * grey scale) rather than in the red error palette — a red block for "I
 * pressed stop myself" reads as a crash.
 *
 * Shape: a thin wave running the full width with the label sitting in the
 * middle of it. The wave is one tiling SVG pattern, so it stretches to any
 * width and stays crisp under the chat's zoom.
 */
export default function InterruptDivider({ label = "已打断" }: { label?: string }) {
  return (
    <div className="flex select-none items-center gap-2 py-1.5 text-dim">
      <Wave />
      <span className="shrink-0 text-xs opacity-70">{label}</span>
      <Wave flip />
    </div>
  );
}

/**
 * One stretchable half of the wave: a fixed-period path tiled by a pattern.
 *
 * Deliberately no viewBox — user units then equal CSS pixels, so the wave
 * keeps its period whatever the container width instead of being squashed or
 * stretched. `flip` mirrors the phase so the two halves read as one line
 * passing behind the label.
 */
function Wave({ flip }: { flip?: boolean }) {
  const id = flip ? "interrupt-wave-r" : "interrupt-wave-l";
  return (
    <svg aria-hidden="true" className="h-2 min-w-0 flex-1 opacity-45" height="8">
      <defs>
        <pattern id={id} width="12" height="8" patternUnits="userSpaceOnUse">
          <path
            d={flip ? "M0 6 Q3 2 6 6 T12 6" : "M0 2 Q3 6 6 2 T12 2"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </pattern>
      </defs>
      <rect width="100%" height="8" fill={`url(#${id})`} />
    </svg>
  );
}
