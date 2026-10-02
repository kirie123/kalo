/**
 * Right column: one tab strip over one content area (文件 / 浏览器 / 终端 / 跟随).
 *
 * Every tab stays mounted while inactive (CSS `hidden`), so switching tabs
 * keeps a shell's scrollback, a browser page and the file browser's expansion;
 * hiding the whole panel does the same. The strip's `+` menu reuses the shared
 * ContextMenu so it renders in a portal like every other menu in the app.
 */

import { useState } from "react";
import { browserTitle } from "../lib/browser-url";
import { useChatSelector } from "../lib/chat-store";
import { loadWidth, startColumnDrag } from "../lib/drag";
import { FILES_TAB_ID, panelTabs, shortCommandLabel, usePanelTabs, type PanelTab } from "../lib/panel-tabs";
import { useToolWatch } from "../lib/tool-watch-registry";
import ContextMenu, { useContextMenu } from "./ContextMenu";
import BrowserTab from "./BrowserTab";
import FilePanel from "./FilePanel";
import ShellTab from "./TerminalTab";
import TerminalWatchTab from "./TerminalWatchTab";

export default function RightPanel({ hidden = false }: { hidden?: boolean }) {
  const panel = usePanelTabs();
  const cwd = useChatSelector((s) => s.cwd);
  const [width, setWidth] = useState(() => loadWidth("kalo.layout.panelW", 640));
  const addMenu = useContextMenu();

  const add = (kind: "files" | "browser" | "terminal") => {
    if (kind === "files") panelTabs.activate(FILES_TAB_ID);
    else if (kind === "browser") panelTabs.newBrowser();
    else panelTabs.newShell(cwd || null);
  };

  return (
    <aside className={`${hidden ? "hidden" : "flex"} min-h-0 shrink-0`}>
      {/* Column splitter (chat | panel) */}
      <div
        onMouseDown={(e) =>
          startColumnDrag(
            e,
            width,
            { min: 320, max: 1400, invert: true, persistKey: "kalo.layout.panelW" },
            setWidth,
          )
        }
        className="w-1 shrink-0 cursor-col-resize border-l border-edge hover:bg-edge"
      />
      <div className="flex min-h-0 shrink-0 flex-col" style={{ width }}>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-edge px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {panel.tabs.map((tab) => (
              <TabChip
                key={tab.id}
                tab={tab}
                active={tab.id === panel.activeId}
                onActivate={() => panelTabs.activate(tab.id)}
                onClose={() => panelTabs.close(tab.id)}
              />
            ))}
          </div>
          <button
            onClick={(e) => addMenu.openAtRect(e.currentTarget)}
            title="新建页签"
            className="shrink-0 rounded-md p-1.5 text-dim hover:bg-card hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {panel.tabs.map((tab) => (
            <div key={tab.id} className={`min-h-0 flex-1 ${tab.id === panel.activeId ? "flex" : "hidden"}`}>
              {tab.kind === "files" ? (
                <FilePanel />
              ) : tab.kind === "browser" ? (
                <BrowserTab tab={tab} />
              ) : tab.kind === "shell" ? (
                <ShellTab id={tab.id} cwd={tab.cwd} />
              ) : (
                <TerminalWatchTab tab={tab} />
              )}
            </div>
          ))}
        </div>
      </div>

      {addMenu.at && (
        <ContextMenu
          at={addMenu.at}
          onClose={addMenu.close}
          items={[
            { label: "文件", action: () => add("files") },
            { label: "浏览器", action: () => add("browser") },
            { label: "终端", action: () => add("terminal") },
          ]}
        />
      )}
    </aside>
  );
}

/** One tab: icon + label; the file tab has no close button. */
function TabChip({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: PanelTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const snapshot = useToolWatch(tab.kind === "watch" ? tab.toolCallId : "");
  const running = tab.kind === "watch" && snapshot?.status === "running";
  const label =
    tab.kind === "files"
      ? "文件"
      : tab.kind === "browser"
        ? browserTitle(tab.url)
        : tab.kind === "shell"
          ? "终端"
          : shortCommandLabel(tab.command) || "命令输出";
  const title = tab.kind === "watch" ? tab.command : tab.kind === "shell" ? (tab.cwd ?? "终端") : label;
  return (
    <div
      className={`flex shrink-0 items-center overflow-hidden rounded-md border ${
        active ? "border-edge bg-card text-ink" : "border-transparent text-dim hover:bg-card"
      }`}
    >
      <button onClick={onActivate} title={title} className="flex min-w-0 max-w-40 items-center gap-1.5 py-1 pl-2 text-xs">
        {running ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)]" />
        ) : (
          <TabIcon tab={tab} />
        )}
        <span className="truncate">{label}</span>
      </button>
      {tab.kind !== "files" && (
        <button onClick={onClose} title="关闭页签" className="px-1.5 py-1 text-dim hover:text-ink">
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function TabIcon({ tab }: { tab: PanelTab }) {
  const common = { width: 10, height: 10, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, className: "shrink-0" } as const;
  if (tab.kind === "files") {
    return (
      <svg {...common}>
        <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
        <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tab.kind === "browser") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 1.5c-1.5 1.5-2.5 3.8-2.5 6.5s1 5 2.5 6.5M8 1.5c1.5 1.5 2.5 3.8 2.5 6.5s-1 5-2.5 6.5M1.5 8h13" strokeLinecap="round" />
      </svg>
    );
  }
  if (tab.kind === "shell") {
    return (
      <svg {...common}>
        <path d="M2.5 3.5l4 4-4 4M8.5 12.5h5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  // Watch mirror: an eye — it looks at a command running elsewhere.
  return (
    <svg {...common}>
      <path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  );
}