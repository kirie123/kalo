import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

/**
 * Self-drawn title bar (the window runs with `decorations: false`).
 *
 * One full-width strip above the sidebar: brand on the left, the current
 * page/session title centered, window buttons on the right. The strip itself
 * carries `data-tauri-drag-region`, so dragging it moves the window and a
 * double-click toggles maximize — both handled by Tauri, which is why the
 * capability needs `core:window:allow-start-dragging`.
 */

/** The Tauri window handle, or null when running in a plain browser (vite dev). */
function tauriWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function TitleBar({ title }: { title: string }) {
  const [win] = useState<Window | null>(tauriWindow);
  const [maximized, setMaximized] = useState(false);

  // Keep the maximize/restore glyph in sync — resizing is the only event that
  // can flip the state (button, double-click, Win+↑, snap).
  useEffect(() => {
    if (!win) return;
    let alive = true;
    const sync = () => {
      void win.isMaximized().then((v) => {
        if (alive) setMaximized(v);
      });
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, [win]);

  return (
    <div
      data-tauri-drag-region
      className="relative z-[100] flex h-8 shrink-0 select-none items-center border-b border-edge bg-sidebar"
    >
      {/* Brand — no pointer events, so this whole area stays draggable. */}
      <div data-tauri-drag-region className="pointer-events-none flex items-center gap-2 pl-3">
        <BrandMark />
        <span className="text-xs font-medium text-ink">Kalo</span>
      </div>

      {/* Centered title; absolute so it ignores the side clusters' widths. */}
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute left-1/2 max-w-[46%] -translate-x-1/2 truncate text-xs text-dim"
      >
        {title}
      </div>

      <div className="ml-auto flex items-center">
        {win && (
          <>
            <WindowButton label="最小化" onClick={() => void win.minimize()}>
              <path d="M2 6h8" />
            </WindowButton>
            <WindowButton label={maximized ? "还原" : "最大化"} onClick={() => void win.toggleMaximize()}>
              {maximized ? (
                <>
                  <rect x="2" y="4" width="6" height="6" />
                  <path d="M4 4V2h6v6H8" />
                </>
              ) : (
                <rect x="2" y="2" width="8" height="8" />
              )}
            </WindowButton>
            <WindowButton label="关闭" onClick={() => void win.close()} danger>
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </WindowButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Windows-style caption button: wide flat rectangle, no radius, close turns
 * red on hover.
 */
function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  /** The close button: red hover instead of the neutral one. */
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-8 w-11 items-center justify-center text-dim ${
        danger ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-card hover:text-ink"
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
        {children}
      </svg>
    </button>
  );
}

/** Small rounded square with the staircase glyph — same family as the sidebar icons. */
function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
      <rect x="0.5" y="0.5" width="15" height="15" rx="4" fill="var(--accent)" />
      <path
        d="M4 11.5h2.5V9h2.5V6.5h2.5V4"
        stroke="var(--accent-contrast)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
