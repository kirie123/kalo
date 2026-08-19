import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

/**
 * Self-drawn title bar (the window runs with `decorations: false`).
 *
 * One full-width strip above the sidebar: the app menus on the left, the
 * current page/session title centered, window buttons on the right. The strip
 * carries `data-tauri-drag-region`, so dragging it moves the window and a
 * double-click toggles maximize — both handled by Tauri, which is why the
 * capability needs `core:window:allow-start-dragging`.
 *
 * The menus are declarative on purpose: App owns every action, this file only
 * knows how to render and dismiss a dropdown.
 */

/** One row in a dropdown. `checked` renders the ✓ column (toggles / radios). */
export type MenuEntry =
  | { kind: "item"; label: string; onClick: () => void; checked?: boolean; disabled?: boolean; hint?: string }
  | { kind: "sep" };

export interface TitleMenu {
  label: string;
  entries: MenuEntry[];
}

/** The Tauri window handle, or null when running in a plain browser (vite dev). */
function tauriWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function TitleBar({ title, menus }: { title: string; menus?: TitleMenu[] }) {
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
      {/* Menu bar — clickable, so it must not carry the drag-region flag. */}
      {menus && menus.length > 0 && <MenuBar menus={menus} />}

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
 * Desktop-style menu bar: click a label to open it, then hovering the other
 * labels switches menus (the usual behaviour once a bar is "armed"). Outside
 * click and Escape close it.
 */
function MenuBar({ menus }: { menus: TitleMenu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="flex items-center pl-1.5">
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            onClick={() => setOpen((v) => (v === i ? null : i))}
            onMouseEnter={() => open !== null && setOpen(i)}
            className={`rounded px-2 py-1 text-xs ${open === i ? "bg-card text-ink" : "text-dim hover:text-ink"}`}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="absolute left-0 top-7 z-50 min-w-52 overflow-hidden rounded-md border border-edge bg-card py-1 shadow-2xl">
              {m.entries.map((e, j) =>
                e.kind === "sep" ? (
                  <div key={`sep${j}`} className="my-1 border-t border-edge" />
                ) : (
                  <button
                    key={e.label}
                    disabled={e.disabled}
                    onClick={() => {
                      setOpen(null);
                      e.onClick();
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink hover:bg-base disabled:cursor-default disabled:text-dim disabled:hover:bg-transparent"
                  >
                    <span className="w-3 shrink-0 text-center text-accent">{e.checked ? "✓" : ""}</span>
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    {e.hint && <span className="mono shrink-0 text-[10px] text-dim">{e.hint}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
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
