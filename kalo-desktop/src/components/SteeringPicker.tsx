import { useEffect, useRef, useState } from "react";
import { chatStore, useChatSelector } from "../lib/chat-store";

type SteeringMode = "all" | "one-at-a-time";

const STEERING_OPTIONS: Array<{ value: SteeringMode; label: string; hint: string }> = [
  { value: "one-at-a-time", label: "逐条插话", hint: "排队的消息一条条送进当前轮" },
  { value: "all", label: "一次全送", hint: "排队的消息一次性全部送进当前轮" },
];

/**
 * Steering-mode dropdown: how queued messages are delivered into a running
 * turn (doc/2026-09-13-输入队列.md). Replaces a native `<select>`, which on
 * Windows can't shed its own chrome and was the one control that refused to
 * match the composer.
 *
 * Sits on the input queue's header — that queue is the only thing the setting
 * acts on, and its old composer slot now holds the agent-map button
 * (doc/2026-09-30-子agent活动面板.md). Self-contained (store in, store out) so
 * the queue component stays a pure renderer.
 *
 * Note: this chip used to be labelled 「权限模式」, which it never was — it
 * controls message steering, not authorization. Real permission modes live in
 * {@link PermissionChip} (doc/2026-09-07-权限模式.md).
 */
export default function SteeringPicker() {
  const mode = useChatSelector((s) => s.steeringMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
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

  const current = STEERING_OPTIONS.find((o) => o.value === mode) ?? STEERING_OPTIONS[0];
  const risky = mode === "all";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="插话投递方式"
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-base ${
          risky ? "text-tone-orange" : "text-dim hover:text-ink"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0">
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
        <span>{current.label}</span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1.5 w-56 overflow-hidden rounded-lg border border-edge bg-card py-1 shadow-lift">
          {STEERING_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                setOpen(false);
                if (o.value !== mode) void chatStore.setSteeringMode(o.value);
              }}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-base"
            >
              <span className="w-3 shrink-0 pt-px text-center text-[var(--ok)]">{o.value === mode ? "✓" : ""}</span>
              <span className="min-w-0">
                <span className="block text-xs text-ink">{o.label}</span>
                <span className="block text-[11px] text-dim">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}