import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Column resize drag helper. Attach to a splitter's onMouseDown.
 *
 * `invert` for right-side panels: dragging left grows the column.
 * `persistKey` stores the final width in localStorage on mouseup.
 */
export function startColumnDrag(
  e: ReactMouseEvent,
  startWidth: number,
  opts: { min: number; max: number; invert?: boolean; persistKey?: string },
  setWidth: (w: number) => void,
) {
  e.preventDefault();
  const startX = e.clientX;
  let last = startWidth;

  const onMove = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    last = Math.min(opts.max, Math.max(opts.min, startWidth + (opts.invert ? -dx : dx)));
    setWidth(last);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    if (opts.persistKey) localStorage.setItem(opts.persistKey, String(last));
  };

  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** Read a persisted width, falling back to the default. */
export function loadWidth(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
