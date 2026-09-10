/**
 * Sidebar row assembly.
 *
 * The sidebar shows two sources at once: sessions found by scanning the
 * sessions directory (`list_sessions`), and sessions an engine has started in
 * this app run but that are not on disk yet — pi withholds the `.jsonl` until
 * the first assistant message, so a fresh chat would otherwise be missing from
 * the sidebar for as long as the first run takes to produce output.
 *
 * The two can describe the same session for one refresh tick (the file exists,
 * the store has not yet been told), so the merge is deduped by path.
 */

import type { PendingSession, ProjectGroup, SessionSummary } from "../types";

/** A sidebar row: an on-disk session, or one still waiting to be written. */
export type SessionRow = SessionSummary & { cwd: string; pending?: boolean };

/** Same normalization as chat-store's normPath (pool keys). */
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/**
 * Flatten the on-disk groups and merge in the optimistic rows, newest first.
 * On-disk wins on a path collision: it carries the engine's real title and
 * mtime, so the swap from optimistic to real is invisible.
 */
export function mergeSessionRows(groups: ProjectGroup[], pending: PendingSession[]): SessionRow[] {
  const rows: SessionRow[] = groups.flatMap((g) => g.sessions.map((s) => ({ ...s, cwd: g.cwd })));
  const onDisk = new Set(rows.map((s) => normPath(s.path)));
  for (const p of pending) {
    if (onDisk.has(normPath(p.path))) continue;
    rows.push({
      path: p.path,
      id: p.id,
      timestamp: p.modifiedMs,
      title: p.title,
      modifiedMs: p.modifiedMs,
      cwd: p.cwd,
      pending: true,
    });
  }
  return rows.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/**
 * Frozen sort keys: normalized session path → the `modifiedMs` the row had
 * when its run started. See doc/2026-09-10-运行中会话排序冻结.md.
 */
export type FreezeTable = Record<string, number>;

/**
 * Incrementally update the freeze table against the current rows:
 * a row that just started running gets its current sort key pinned, a row that
 * stopped running (or vanished from the list) is released. Returns `prev`
 * unchanged when nothing moved, so callers can skip re-sorting.
 */
export function updateFreeze(
  prev: FreezeTable,
  rows: SessionRow[],
  isRunning: (path: string) => boolean,
): FreezeTable {
  const next: FreezeTable = {};
  for (const row of rows) {
    if (!isRunning(row.path)) continue;
    const key = normPath(row.path);
    // Already frozen → keep the original snapshot, don't re-pin to a newer mtime.
    next[key] = prev[key] ?? row.modifiedMs;
  }
  const prevKeys = Object.keys(prev);
  const same =
    prevKeys.length === Object.keys(next).length && prevKeys.every((k) => prev[k] === next[k]);
  return same ? prev : next;
}

/**
 * Order rows newest-first by their frozen key when they have one, and by their
 * live `modifiedMs` otherwise. Ties keep the input order (Array#sort is stable),
 * so a running session stays put while its file keeps growing.
 */
export function orderRows(rows: SessionRow[], freeze: FreezeTable): SessionRow[] {
  if (Object.keys(freeze).length === 0) return rows;
  const keyOf = (row: SessionRow) => freeze[normPath(row.path)] ?? row.modifiedMs;
  return [...rows].sort((a, b) => keyOf(b) - keyOf(a));
}

/** How many session rows a sidebar list shows before「显示更多」. */
export const SESSION_PAGE_SIZE = 10;

/**
 * The first `limit` rows, plus any row `keep` marks as must-show — the active
 * session and running ones would otherwise be hidden behind「显示更多」, and
 * their selection / spinner with them. Kept rows stay in the input's order
 * (newest first), so nothing jumps around when a run starts deep in history.
 */
export function visibleRows(
  rows: SessionRow[],
  limit: number,
  keep?: (row: SessionRow) => boolean,
): SessionRow[] {
  if (rows.length <= limit) return rows;
  return rows.filter((row, i) => i < limit || (keep ? keep(row) : false));
}
