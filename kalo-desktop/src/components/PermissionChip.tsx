import { useEffect, useRef, useState } from "react";
import { chatStore, useChatSelector } from "../lib/chat-store";
import { PERMISSION_MODE_LABELS, PERMISSION_MODES, type PermissionMode } from "../types";

/**
 * Permission-mode chip: the session's authorization level (see
 * doc/2026-09-07-权限模式.md). Always visible when the engine reports a mode,
 * because knowing which mode you are in is the precondition for the mode being
 * useful at all.
 *
 * `full-auto` renders in orange: it is the one value worth noticing at a
 * glance. `custom` is display-only and cannot be selected.
 */
export default function PermissionChip() {
  const mode = useChatSelector((s) => s.permissionMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // No mode reported: the engine has no permission extension loaded, so there
  // is nothing to control and a chip would lie about being in effect.
  if (!mode) return null;

  const risky = mode === "full-auto";
  const label = mode === "custom" ? "自定义" : PERMISSION_MODE_LABELS[mode].label;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="权限模式：决定改动与命令是否需要你审批"
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-card ${
          risky ? "text-tone-orange" : "text-dim hover:text-ink"
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          className="shrink-0"
        >
          {risky ? (
            <>
              <path d="M8 2.2l5.6 10.3a.8.8 0 01-.7 1.2H3.1a.8.8 0 01-.7-1.2L8 2.2z" strokeLinejoin="round" />
              <path d="M8 6.4v3M8 11.4h.01" strokeLinecap="round" />
            </>
          ) : (
            <>
              <path d="M8 2l4.5 1.8v4.3c0 2.6-1.8 4.8-4.5 5.7-2.7-.9-4.5-3.1-4.5-5.7V3.8L8 2z" strokeLinejoin="round" />
              <path d="M6 8l1.6 1.6L10.3 7" strokeLinecap="round" strokeLinejoin="round" />
            </>
          )}
        </svg>
        <span>{label}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="shrink-0"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-64 overflow-hidden rounded-lg border border-edge bg-card py-1 shadow-lift">
          {PERMISSION_MODES.map((value) => (
            <button
              key={value}
              onClick={() => {
                setOpen(false);
                void chatStore.setPermissionMode(value as PermissionMode);
              }}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-base"
            >
              <span className="w-3 shrink-0 pt-px text-center text-[var(--ok)]">{value === mode ? "✓" : ""}</span>
              <span className="min-w-0">
                <span className="block text-xs text-ink">{PERMISSION_MODE_LABELS[value].label}</span>
                <span className="block text-[11px] text-dim">{PERMISSION_MODE_LABELS[value].hint}</span>
              </span>
            </button>
          ))}
          <p className="border-t border-edge px-3 pb-1 pt-1.5 text-[11px] leading-snug text-dim">
            权限模式防的是误操作，不是恶意绕过：被放行的命令内部仍可做任何事。
          </p>
        </div>
      )}
    </div>
  );
}
