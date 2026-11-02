import { useId, useState } from "react";

/** Compact collapsible row for assistant thinking content; folded by default. */
export default function ThinkingBlock({ thinking, live }: { thinking: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  if (!thinking.trim() && !live) return null;
  return (
    <div className="thinking-block my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center gap-1.5 py-1.5 text-left text-[13px] text-dim hover:text-ink"
      >
        <svg
          aria-hidden="true"
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
      <div id={contentId} className="thinking-disclosure" data-open={open} aria-hidden={!open}>
        <div>
          <div className="thinking-content">{thinking}</div>
        </div>
      </div>
    </div>
  );
}
