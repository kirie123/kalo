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
