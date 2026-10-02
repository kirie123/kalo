/**
 * Right-panel tab state: 文件 / 浏览器 / 终端 / 跟随.
 *
 * The right column is one tab container (CoWith-style): a tab strip with a `+`
 * menu, and every open thing — the file browser, a web page, a shell, a bash
 * mirror — is a tab in it. The strip lives in the shell while the triggers are
 * deep inside the timeline (a tool row's 「在终端中打开」), so the state is a
 * module-level store, like chatStore, rather than React state in App.
 *
 * The pure reducers at the top are exported for tests; the singleton below is
 * only glue (state + notify + watch-registry seeding).
 *
 * Tab state is app-lifetime and not persisted: terminals are processes and a
 * restart has none. Browsing memory stays in file-panel-memory (per session).
 */

import { useSyncExternalStore } from "react";
import { clearToolWatch, seedToolWatch } from "./tool-watch-registry";

export type PanelTab =
  | { id: "files"; kind: "files" }
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
  activeId: string;
}

/** The file-browser tab is a singleton and always present. */
export const FILES_TAB_ID = "files";

export const initialPanelState: PanelState = {
  open: true,
  tabs: [{ id: FILES_TAB_ID, kind: "files" }],
  activeId: FILES_TAB_ID,
};

/** Show/hide the whole right column (the tab set is untouched). */
export function togglePanel(state: PanelState): PanelState {
  return { ...state, open: !state.open };
}

export function activateTab(state: PanelState, id: string): PanelState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state;
}

/**
 * Add (or focus) a tab and make it current. Three of the four kinds are
 * singletons in disguise: the file tab exists once, a watch tab belongs to
 * exactly one tool call, and two browser tabs pointing at the same URL are the
 * same page — none of them may stack duplicates. Only shells always add.
 */
export function addTab(state: PanelState, tab: PanelTab): PanelState {
  if (tab.kind === "files") return { ...state, open: true, activeId: FILES_TAB_ID };
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
 * Close a tab. The file tab never closes. Focus falls to the tab on its left
 * (stable, and the neighbour the user most likely wants); closing the first
 * extra tab falls back to 文件.
 */
export function closeTab(state: PanelState, id: string): PanelState {
  if (id === FILES_TAB_ID) return state;
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const activeId = state.activeId === id ? (tabs[index - 1]?.id ?? FILES_TAB_ID) : state.activeId;
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