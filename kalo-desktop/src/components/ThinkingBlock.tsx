import { useState } from "react";

/** Compact collapsible row for assistant thinking content; folded by default. */
export default function ThinkingBlock({ thinking, live }: { thinking: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!thinking.trim() && !live) return null;
  return (
    <div className="thinking-block my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1.5 text-left text-[13px] text-dim hover:text-ink"
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>
          {live ? "正在思考" : "思考过程"}
          {live && <span className="spinner ml-2 align-middle" />}
        </span>
      </button>
      {open && (
        <div className="ml-2 mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-edge bg-card px-3 py-2 text-xs not-italic leading-relaxed text-dim">
          {thinking}
        </div>
      )}
    </div>
  );
}
