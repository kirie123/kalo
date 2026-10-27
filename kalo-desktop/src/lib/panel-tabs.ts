/**
 * Right-panel tab state: 浏览器 / 终端 / 跟随（应用级页签）。
 *
 * The right column is one tab container: a tab strip with a `+` menu, and every
 * open thing is a tab in it. **Open files are tabs too, but they live in
 * `file-panel-memory`** (per session, doc/2026-10-10-右栏文件页签.md), so the
 * strip renders this store's tabs after those. `activeId` is only set while one
 * of *these* tabs is on screen; `""` means "no non-file tab", and the file side
 * then decides what shows: one of its file tabs, or the bare tree.
 *
 * The strip lives in the shell while the triggers are deep inside the timeline
 * (a tool row's 「在终端中打开」), so the state is a module-level store, like
 * chatStore, rather than React state in App.
 *
 * The pure reducers at the top are exported for tests; the singleton below is
 * only glue (state + notify + watch-registry seeding).
 *
 * Tab state is app-lifetime and not persisted: terminals are processes and a
 * restart has none. Open files and browsing memory stay in file-panel-memory.
 */

import { useSyncExternalStore } from "react";
import { clearToolWatch, seedToolWatch } from "./tool-watch-registry";

export type PanelTab =
  | { id: string; kind: "browser"; url: string }
  | { id: string; kind: "shell"; cwd: string | null }
  | {
      id: string;
      kind: "watch";
      toolCallId: string;
      /** The bash command, for the tab label and the in-terminal echo line. */
      command: string;
      startedAt?: number;
    };

export interface PanelState {
  open: boolean;
  tabs: PanelTab[];
  /** Current non-file tab; `""` = none on screen (the file side shows). */
  activeId: string;
}

export const initialPanelState: PanelState = { open: false, tabs: [], activeId: "" };

/** Show/hide the whole right column (the tab set is untouched). */
export function togglePanel(state: PanelState): PanelState {
  return { ...state, open: !state.open };
}

/** Reveal the file area, retaining all browser / terminal / watch tabs. */
export function showFilePanel(state: PanelState): PanelState {
  return { ...state, open: true, activeId: "" };
}

/** Focus one tab, or `""` to hand the screen back to the file side. */
export function activateTab(state: PanelState, id: string): PanelState {
  if (id === "") return { ...state, activeId: "" };
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state;
}

/**
 * Add (or focus) a tab and make it current. Two of the kinds are singletons in
 * disguise: a watch tab belongs to exactly one tool call, and two browser tabs
 * pointing at the same URL are the same page — neither may stack duplicates.
 * Only shells always add.
 */
export function addTab(state: PanelState, tab: PanelTab): PanelState {
  const existing =
    tab.kind === "watch"
      ? state.tabs.find((t) => t.kind === "watch" && t.toolCallId === tab.toolCallId)
      : tab.kind === "browser"
        ? state.tabs.find((t) => t.kind === "browser" && t.url === tab.url)
        : undefined;
  if (existing) return { ...state, open: true, activeId: existing.id };
  return { ...state, open: true, tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * Close a tab. Focus falls to the tab on its left (stable, and the neighbour
 * the user most likely wants); closing the leftmost one falls to the tab that
 * took its place, and closing the last one clears `activeId` — the file side
 * (one of its tabs, or the bare tree) then takes the screen.
 */
export function closeTab(state: PanelState, id: string): PanelState {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const activeId = state.activeId === id ? (tabs[index - 1]?.id ?? tabs[0]?.id ?? "") : state.activeId;
  return { ...state, tabs, activeId };
}

/** Navigate a browser tab (address bar and chip label share this one field). */
export function setTabUrl(state: PanelState, id: string, url: string): PanelState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id && t.kind === "browser" ? { ...t, url } : t)),
  };
}

/** Tab label for a watched command: enough to tell two commands apart. */
export function shortCommandLabel(command: string, max = 18): string {
  const line = command.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

let tabCounter = 1;

/** Frontend-generated tab id; must satisfy the backend's id validation. */
export function nextTabId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${tabCounter++}`;
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let state: PanelState = initialPanelState;
const listeners = new Set<() => void>();

function update(next: PanelState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export interface WatchTabSeed {
  toolCallId: string;
  command: string;
  startedAt?: number;
  status: "running" | "success" | "error";
  partialResult?: unknown;
  result?: unknown;
}

export const panelTabs = {
  toggle: () => update(togglePanel(state)),
  showFiles: () => update(showFilePanel(state)),
  activate: (id: string) => update(activateTab(state, id)),
  close: (id: string) => {
    const tab = state.tabs.find((t) => t.id === id);
    // The mirror's stream has no reader left; the row still holds its copy.
    if (tab?.kind === "watch") clearToolWatch(tab.toolCallId);
    update(closeTab(state, id));
  },
  newShell: (cwd: string | null) => update(addTab(state, { id: nextTabId("t"), kind: "shell", cwd })),
  newBrowser: () => update(addTab(state, { id: nextTabId("b"), kind: "browser", url: "" })),
  setBrowserUrl: (id: string, url: string) => update(setTabUrl(state, id, url)),
  /**
   * Open (or focus) the mirror tab for one bash call. Seeds the watch
   * registry with what the row already has — for a replayed history row the
   * live events are gone, and for a running row it avoids a blank frame until
   * the next partial arrives.
   */
  openWatchTab: (seed: WatchTabSeed) => {
    seedToolWatch(seed.toolCallId, {
      status: seed.status,
      partialResult: seed.partialResult,
      result: seed.result,
    });
    update(
      addTab(state, {
        id: `w-${seed.toolCallId}`,
        kind: "watch",
        toolCallId: seed.toolCallId,
        command: seed.command,
        startedAt: seed.startedAt,
      }),
    );
  },
};

export function usePanelTabs(): PanelState {
  return useSyncExternalStore(subscribe, () => state);
}
