import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { chatStore } from "../lib/chat-store";
import { openPath } from "../lib/pi-bridge";

/** One row of a context menu. `danger` colors destructive actions. */
export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

/** Where the menu's top-left corner goes, in viewport coordinates. */
export interface MenuAnchor {
  x: number;
  y: number;
}

/** `min-w-40` in pixels — used for the edge clamp and for right-aligning. */
const MENU_WIDTH = 160;
/** Rough row height (text + padding), for the bottom-edge clamp. */
const ROW_HEIGHT = 34;

/**
 * Cursor-anchored menu, shared by the sidebar, the changed-files card and the
 * file panel.
 *
 * Portaled to <body> on purpose: the conversation column is scaled with CSS
 * `zoom` (see ChatView), and a `position: fixed` box inside a zoomed ancestor
 * gets scaled and offset with it. Out here the anchor is plain viewport
 * coordinates, so a menu opened at 130% zoom still lands under the cursor.
 */
export default function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase + stopImmediatePropagation: Escape closes the menu only,
      // and doesn't also reach the full-screen preview / modal behind it.
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // Keep the menu inside the window.
  const x = Math.min(at.x, window.innerWidth - MENU_WIDTH - 20);
  const y = Math.min(at.y, window.innerHeight - items.length * ROW_HEIGHT - 16);

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        // A second right-click closes the menu instead of surfacing the
        // webview's own menu.
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="absolute min-w-40 rounded-lg border border-edge bg-card py-1 shadow-2xl"
        style={{ left: Math.max(0, x), top: Math.max(0, y) }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            onClick={run(item.action)}
            className={`flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-base ${
              item.danger ? "text-[var(--danger)]" : "text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Open/close plumbing for one menu: `onContextMenu` on the row, `openAtRect`
 * for a click-to-open button ("..."), `at` non-null while the menu is open.
 */
export function useContextMenu() {
  const [at, setAt] = useState<MenuAnchor | null>(null);
  return {
    at,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      // Rows can nest (a session row inside a project row); only the innermost
      // one should answer.
      e.stopPropagation();
      setAt({ x: e.clientX, y: e.clientY });
    },
    /**
     * Anchor under a button, right edges aligned — where the sidebar's old
     * 「...」dropdown used to sit, so it stays inside the narrow column.
     */
    openAtRect: (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setAt({ x: r.right - MENU_WIDTH, y: r.bottom + 2 });
    },
    close: () => setAt(null),
  };
}

/** 「复制路径」— shared by every menu that shows a filesystem path. */
export function copyPathItem(path: string, label = "复制路径"): MenuItem {
  return {
    label,
    action: () => {
      void navigator.clipboard.writeText(path).then(
        () => chatStore.pushToast("路径已复制", "info"),
        () => chatStore.pushToast("复制失败", "warning"),
      );
    },
  };
}

/**
 * 「打开文件」/「打开所在文件夹」— `reveal` shows the path in the OS file
 * manager instead of opening it with the default app.
 */
export function openPathItem(label: string, path: string, reveal = false): MenuItem {
  return {
    label,
    action: () => {
      void openPath(path, reveal).catch((e: unknown) =>
        chatStore.pushToast(`打开失败：${e instanceof Error ? e.message : String(e)}`, "error"),
      );
    },
  };
}
