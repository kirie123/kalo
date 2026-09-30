/**
 * Per-session memory for the file panel (doc/2026-09-30-文件面板按会话记忆.md).
 *
 * "Which directory am I browsing, what is open, what is expanded" belongs to
 * the session, not to the panel widget: collapsing the panel must not close
 * the open file, and switching sessions must not wipe one session's file area
 * with another's browsing. The panel therefore keeps only transient state
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

export interface PanelPreview {
  name: string;
  path: string;
  /** Posix path relative to the repo root; null outside a repository. */
  relPath: string | null;
}

/** Which view the preview column is showing. */
export type PanelTab = "source" | "diff";

/**
 * A live `present_files` deliverable waiting for its session's panel.
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

/** A live deliverable of a session (engine `present_files` item, narrowed to
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
  preview: PanelPreview | null;
  previewTab: PanelTab;
  changesOnly: boolean;
  backStack: string[];
  artifactsOpen: boolean;
  /**
   * Deliverable declared by a live `present_files` of this session, opened by
   * the panel the next time this session is on screen (then cleared).
   */
  pendingArtifact: PendingArtifact | null;
}

/** The blank file area of a session that has not been browsed yet. */
function fresh(root: string): PanelMemory {
  return {
    rootOverride: null,
    root,
    expanded: [],
    preview: null,
    previewTab: "source",
    changesOnly: false,
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
 * longer matches the effective root keeps its preview (an open file is not
 * closed by changing the working directory) but drops its expanded set (those
 * paths may not exist under the new root).
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

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Subscribe to memory writes (the hook's channel). */
export const subscribePanelMemory = subscribe;

/**
 * Record a live deliverable for the session that declared it. Called from the
 * present_files live path (lib/artifacts.ts), which knows the owning session's
 * uid and cwd — the two things routing the open needs. URLs and files the
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