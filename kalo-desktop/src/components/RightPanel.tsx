/**
 * Right column: one tab strip over one content area.
 *
 * The strip carries two kinds of tab, in this order: the **files this session
 * has open** (per session, from file-panel-memory) and the app-level tabs —
 * 浏览器 / 终端 / 跟随 (from panel-tabs). Two stores, two questions: panel-tabs
 * decides who has the screen (`activeId`), the file area remembers which file it
 * shows (`activeFile`). Focusing a file tab hands the screen back to the file
 * side; focusing a panel tab leaves the file side's own focus alone. With no
 * file focused the file side shows the bare tree, and there is no permanent
 * 「文件」tab anymore (doc/2026-10-10-右栏文件页签.md). The strip keeps its tabs
 * left-aligned with `+` right after them, so a couple of open files never push
 * the button to the far edge.
 *
 * Every tab stays mounted while inactive (CSS `hidden`), so switching tabs
 * keeps a shell's scrollback, a browser page and the file browser's expansion;
 * hiding the whole panel does the same. The strip's `+` menu reuses the shared
 * ContextMenu so it renders in a portal like every other menu in the app.
 */

import { useEffect, useState } from "react";
import { browserTitle } from "../lib/browser-url";
import { useChatSelector } from "../lib/chat-store";
import { loadWidth, startColumnDrag } from "../lib/drag";
import {
  activateFileInMemory,
  closeFileInMemory,
  openFileInMemory,
  patchPanelMemory,
  usePanelMemory,
  type PanelFile,
} from "../lib/file-panel-memory";
import { panelTabs, shortCommandLabel, usePanelTabs, type PanelTab } from "../lib/panel-tabs";
import { useToolWatch } from "../lib/tool-watch-registry";
import ContextMenu, { useContextMenu } from "./ContextMenu";
import BrowserTab from "./BrowserTab";
import FilePanel from "./FilePanel";
import ShellTab from "./TerminalTab";
import TerminalWatchTab from "./TerminalWatchTab";
import AppIcon from "./AppIcon";

export default function RightPanel({ hidden = false }: { hidden?: boolean }) {
  const panel = usePanelTabs();
  const cwd = useChatSelector((s) => s.cwd);
  const [width, setWidth] = useState(() => loadWidth("kalo.layout.panelW", 640));
  const addMenu = useContextMenu();

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
        <div className="right-panel-tabbar">
          <TabStrip />
          <button
            onClick={(e) => addMenu.openAtRect(e.currentTarget)}
            title="新建页签"
            className="shrink-0 rounded-md p-1.5 text-dim hover:bg-card hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
          </button>
          <FileTreeToggle />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Files are not a panel tab: the file side (an open file, or the
              bare tree) fills the column whenever no browser / shell / watch
              tab is current. */}
          <div className={`min-h-0 flex-1 ${panel.activeId === "" ? "flex" : "hidden"}`}>
            <FilePanel />
          </div>
          {panel.tabs.map((tab) => (
            <div key={tab.id} className={`min-h-0 flex-1 ${tab.id === panel.activeId ? "flex" : "hidden"}`}>
              {tab.kind === "browser" ? (
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
            { label: "浏览器", action: () => panelTabs.newBrowser() },
            { label: "终端", action: () => panelTabs.newShell(cwd || null) },
          ]}
        />
      )}
    </aside>
  );
}

function FileTreeToggle() {
  const uid = useChatSelector((state) => state.sessionUid);
  const cwd = useChatSelector((state) => state.cwd);
  const memory = usePanelMemory(uid, cwd);
  const panel = usePanelTabs();
  const visible = panel.activeId === "" && (memory.treeVisible || !memory.activeFile);
  return <button className="file-tree-toggle" title={visible && memory.activeFile ? "收起文件树" : "显示文件树"} aria-label={visible && memory.activeFile ? "收起文件树" : "显示文件树"}
    aria-pressed={visible} onClick={() => {
      patchPanelMemory(uid, cwd, { treeVisible: panel.activeId !== "" || !memory.activeFile || !memory.treeVisible });
      panelTabs.activate("");
    }}><AppIcon name="panel" size={17} /></button>;
}

/** The strip's left part: this session's file tabs, then the app-level tabs.
 *
 * Kept apart from RightPanel so that a write to the file area (browsing the
 * tree, opening a file) re-renders the chips and not the tab contents. */
function TabStrip() {
  const panel = usePanelTabs();
  const cwd = useChatSelector((s) => s.cwd);
  const uid = useChatSelector((s) => s.sessionUid);
  const mem = usePanelMemory(uid, cwd);

  // A live present_files deliverable lands as a new file tab and takes the
  // screen: whoever declared it wants it seen. Consumed here because the strip
  // is what owns "which file tab is current"; the queue itself is per session
  // (lib/artifacts.ts), so a deliverable of a background session waits for its
  // own session's strip instead of popping into whatever is on screen
  // (doc/2026-09-28-产物呈现通道.md § 自动打开). History replay never queues.
  useEffect(() => {
    const pending = mem.pendingArtifact;
    if (!pending) return;
    patchPanelMemory(uid, cwd, {
      ...openFileInMemory(mem, { name: pending.name, path: pending.path }),
      pendingArtifact: null,
    });
    panelTabs.activate("");
  }, [mem, uid, cwd]);

  /** Focus one open file tab (also handing the screen back from a panel tab). */
  const openFileTab = (path: string) => {
    patchPanelMemory(uid, cwd, activateFileInMemory(mem, path));
    panelTabs.activate("");
  };

  // Focusing a browser / shell / watch tab leaves `activeFile` alone: panel-tabs
  // decides who has the screen, this store only says which file the file side
  // shows — and closing that tab then comes back to the file being read, as it
  // did before the file tabs existed.

  /** Close one file tab from its chip's × (the focus rules live in the store). */
  const closeFileTab = (path: string) => patchPanelMemory(uid, cwd, closeFileInMemory(mem, path));

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto">
      {mem.openFiles.map((file) => (
        <FileTabChip
          key={file.path}
          file={file}
          active={panel.activeId === "" && file.path === mem.activeFile}
          onActivate={() => openFileTab(file.path)}
          onClose={() => closeFileTab(file.path)}
        />
      ))}
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
  );
}

/** One open file's tab: icon + filename + the × that closes it. The preview row
 * carries its own ✕ as well — both close the same tab. */
function FileTabChip({
  file,
  active,
  onActivate,
  onClose,
}: {
  file: PanelFile;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`file-tab-chip flex shrink-0 items-center overflow-hidden rounded-md border ${
        active ? "border-edge bg-card text-ink" : "border-transparent text-dim hover:bg-card"
      }`}
    >
      <button onClick={onActivate} aria-pressed={active} title={file.path} className="flex min-w-0 max-w-40 items-center gap-1.5 py-1 pl-2 text-xs">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0">
          <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
          <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
        </svg>
        <span className="truncate">{file.name}</span>
      </button>
      <button onClick={onClose} title="关闭这个文件" aria-label={`关闭 ${file.name}`} className="px-1.5 py-1 text-dim hover:text-ink">
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** One browser / shell / watch tab: icon + label + close button. */
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
    tab.kind === "browser"
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
      <button onClick={onClose} title="关闭页签" className="px-1.5 py-1 text-dim hover:text-ink">
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function TabIcon({ tab }: { tab: PanelTab }) {
  const common = { width: 10, height: 10, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, className: "shrink-0" } as const;
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
