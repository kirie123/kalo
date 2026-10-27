/**
 * Per-session memory for the file panel (doc/2026-09-30-文件面板按会话记忆.md,
 * doc/2026-10-10-右栏文件页签.md).
 *
 * "Which directory am I browsing, which files are open, what is expanded"
 * belongs to the session, not to the panel widget: collapsing the panel must not
 * close the open files, and switching sessions must not wipe one session's file
 * area with another's browsing. The panel therefore keeps only transient state
 * locally (directory listings, git status, diff lines, context menu) and reads
 * the remembered fields from here.
 *
 * Buckets are keyed by the session's stable uid (ChatState.sessionUid), which
 * survives the `fresh-N` -> session-file re-key of a new chat.
 *
 * In-memory only: like drafts and attachments, this session state starts empty
 * after a restart. No IPC, no DOM — the resolve/patch rules are unit-tested.
 */

import { useMemo, useSyncExternalStore } from "react";
import { normPath } from "./chat-store-helpers";

/** One open file tab: identity (path), title, and the 源码/diff choice. */
export interface PanelFile {
  name: string;
  path: string;
  /** Posix path relative to the repo root; null outside a repository. */
  relPath: string | null;
  /** Which view this file's tab is showing. */
  view: FileView;
}

/** Which view a file tab shows. */
export type FileView = "source" | "diff";

/**
 * A clicked or live `present_files` deliverable waiting for its session's panel.
 *
 * A deliverable declared while its session ran in the background must not pop
 * into the file area of whatever session happens to be on screen; it waits here
 * and the panel opens it as soon as that session is the active one. See
 * doc/2026-09-28-产物呈现通道.md § 自动打开.
 */
export interface PendingArtifact {
  name: string;
  path: string;
}

/** A deliverable of a session (engine `present_files` item, narrowed to
 *  the fields the panel needs). */
export interface Deliverable {
  kind: "file" | "url";
  name: string;
  path: string;
  /** True when the engine could not stat the path: nothing to open. */
  missing?: true;
}

export interface PanelMemory {
  /** Directory the user navigated to; null = follow the session cwd. */
  rootOverride: string | null;
  /**
   * The root these records belong to (`rootOverride ?? cwd`). When it no
   * longer matches (the session's working directory changed, or the user
   * browsed elsewhere) the expanded set is stale and gets dropped — see
   * resolvePanelMemory.
   */
  root: string;
  expanded: string[];
  /** The open file tabs, in strip order (doc/2026-10-10-右栏文件页签.md). */
  openFiles: PanelFile[];
  /** The file tab on screen, by path; null = no file tab (the tree shows). */
  activeFile: string | null;
  changesOnly: boolean;
  treeVisible: boolean;
  backStack: string[];
  artifactsOpen: boolean;
  /**
   * Deliverable clicked or declared live in this session, opened by the panel
   * the next time this session is on screen (then cleared).
   */
  pendingArtifact: PendingArtifact | null;
}

/** The blank file area of a session that has not been browsed yet. */
function fresh(root: string): PanelMemory {
  return {
    rootOverride: null,
    root,
    expanded: [],
    openFiles: [],
    activeFile: null,
    changesOnly: false,
    treeVisible: false,
    backStack: [],
    artifactsOpen: true,
    pendingArtifact: null,
  };
}

const entries = new Map<string, PanelMemory>();
/** sessionUid -> the session file it turned out to be (see adoptPanelMemory). */
const aliases = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();

const notify = () => {
  version++;
  for (const l of listeners) l();
};

/** The bucket a uid's memory lives in: the session file once it is known. */
const bucketOf = (uid: string) => aliases.get(uid) ?? uid;

/**
 * A new chat starts life as `fresh-N`; when the engine reports the session file
 * the runtime is re-keyed to that path. Record the same move here so the memory
 * follows the conversation instead of the throwaway runtime name — otherwise
 * reopening that session later (its engine may have been evicted meanwhile)
 * would look under the session file and find nothing.
 */
export function adoptPanelMemory(uid: string, sessionFile: string): void {
  if (uid === sessionFile || aliases.get(uid) === sessionFile) return;
  aliases.set(uid, sessionFile);
  const cur = entries.get(uid);
  if (!cur) return;
  entries.delete(uid);
  entries.set(sessionFile, cur);
  notify();
}

/**
 * The remembered file area of `uid` under `cwd`.
 *
 * A missing bucket is the blank file area; a bucket whose root baseline no
 * longer matches the effective root keeps its open file tabs (an open file is
 * not closed by changing the working directory) but drops its expanded set
 * (those paths may not exist under the new root).
 */
export function resolvePanelMemory(uid: string, cwd: string): PanelMemory {
  const m = entries.get(bucketOf(uid)) ?? fresh(cwd);
  const root = m.rootOverride ?? cwd;
  return m.root === root ? m : { ...m, root, expanded: [] };
}

/**
 * Update one session's memory. The root baseline is re-derived from
 * rootOverride/cwd; a patch that moves the effective root drops the expanded
 * set (those paths belong to the tree it just left behind).
 */
export function patchPanelMemory(uid: string, cwd: string, partial: Partial<PanelMemory>): void {
  const cur = resolvePanelMemory(uid, cwd);
  const rootOverride = "rootOverride" in partial ? (partial.rootOverride ?? null) : cur.rootOverride;
  const root = rootOverride ?? cwd;
  const expanded = partial.expanded ?? (root === cur.root ? cur.expanded : []);
  entries.set(bucketOf(uid), { ...cur, ...partial, rootOverride, root, expanded });
  notify();
}

// ---------------------------------------------------------------------------
// File tabs (pure operations on one session's file area)
// ---------------------------------------------------------------------------
//
// The open file tabs live here, not in panel-tabs: which files are open is part
// of "what this session is looking at", so switching sessions swaps the strip.
// panel-tabs owns "who has the screen" (its `activeId`), this store owns which
// file the file side shows (`activeFile`): focusing a file tab clears
// `activeId`, but opening a panel tab leaves `activeFile` alone, so closing it
// comes back to the same file (doc/2026-10-10-右栏文件页签.md §3).

/** The open file tab matching `path`, or null. */
export function openFileOf(mem: PanelMemory, path: string | null): PanelFile | null {
  if (!path) return null;
  const key = normPath(path);
  return mem.openFiles.find((f) => normPath(f.path) === key) ?? null;
}

/**
 * Open (or re-focus) one file tab and make it current. Opening an already-open
 * file never stacks a second tab: the existing one is focused and refreshed
 * with what the caller knows (a field left undefined is kept as it was).
 */
export function openFileInMemory(
  mem: PanelMemory,
  file: { name: string; path: string; relPath?: string | null; view?: FileView },
): Partial<PanelMemory> {
  const key = normPath(file.path);
  const index = mem.openFiles.findIndex((f) => normPath(f.path) === key);
  if (index < 0) {
    const tab: PanelFile = {
      name: file.name,
      path: file.path,
      relPath: file.relPath ?? null,
      view: file.view ?? "source",
    };
    return { openFiles: [...mem.openFiles, tab], activeFile: file.path };
  }
  const openFiles = mem.openFiles.map((f, i) =>
    i === index
      ? {
          ...f,
          name: file.name || f.name,
          relPath: file.relPath !== undefined ? file.relPath : f.relPath,
          view: file.view ?? f.view,
        }
      : f,
  );
  return { openFiles, activeFile: mem.openFiles[index].path };
}

/**
 * Close one file tab. When the closed tab was the current one, focus falls to
 * the tab on its left, then to the tab that took its place (closing the first
 * of several), then to no tab at all — which is what brings the tree back.
 */
export function closeFileInMemory(mem: PanelMemory, path: string): Partial<PanelMemory> {
  const key = normPath(path);
  const index = mem.openFiles.findIndex((f) => normPath(f.path) === key);
  if (index < 0) return {};
  const openFiles = mem.openFiles.filter((_, i) => i !== index);
  if (mem.activeFile === null || normPath(mem.activeFile) !== key) return { openFiles };
  return { openFiles, activeFile: openFiles[index - 1]?.path ?? openFiles[0]?.path ?? null };
}

/** Switch one file tab between 源码 and diff (a no-op for a path not open). */
export function setFileViewInMemory(mem: PanelMemory, path: string, view: FileView): Partial<PanelMemory> {
  const key = normPath(path);
  if (!mem.openFiles.some((f) => normPath(f.path) === key)) return {};
  return { openFiles: mem.openFiles.map((f) => (normPath(f.path) === key ? { ...f, view } : f)) };
}

/** Make one open file the current tab; null means "no file tab" (the tree). */
export function activateFileInMemory(mem: PanelMemory, path: string | null): Partial<PanelMemory> {
  if (path === null) return { activeFile: null };
  // The tab's own spelling, so the focused path always matches an open tab
  // even when the caller's differs in case or separators.
  const tab = openFileOf(mem, path);
  return tab ? { activeFile: tab.path } : {};
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
/** Subscribe to memory writes (the hook's channel). */
export const subscribePanelMemory = subscribe;

/**
 * Record a deliverable for its session. Called from the live present_files
 * path (lib/artifacts.ts) or a manual click, with the owning session's uid and
 * cwd — the two things routing the open needs. URLs and files the
 * engine could not stat are dropped here: there is nothing to preview.
 */
export function queuePanelArtifactOpen(uid: string, cwd: string, item: Deliverable): void {
  if (item.kind !== "file" || item.missing) return;
  patchPanelMemory(uid, cwd, { pendingArtifact: { name: item.name, path: item.path } });
}

const snapshot = () => version;

/** The active session's file area, re-read whenever it or the memory changes. */
export function usePanelMemory(uid: string, cwd: string): PanelMemory {
  const v = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => resolvePanelMemory(uid, cwd), [uid, cwd, v]);
}
