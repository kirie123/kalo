/**
 * Git helpers for the file panel: turning a `GitStatus` snapshot into
 * per-row lookups, and parsing `git diff` output for `DiffView`.
 *
 * Pure functions only — every one of them is unit-testable without a repo.
 */

import type { DiffLine } from "../components/DiffView";
import type { GitEntry, GitStatus } from "../types";

/**
 * Canonical map key for a filesystem path.
 *
 * Same normalization as `chat-store.ts`: git prints posix separators while
 * `list_dir` returns native ones, and Windows paths differ in case between the
 * two often enough that a case-sensitive key silently loses rows.
 */
export function pathKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Directory rollup for a tree row that has no git entry of its own. */
export interface DirRollup {
  /** Number of changed entries anywhere beneath this directory. */
  count: number;
  /** True when the directory itself is an untracked-and-collapsed entry. */
  untracked: boolean;
}

export interface StatusIndex {
  /** Exact path → entry. */
  byPath: Map<string, GitEntry>;
  /** Directory path → rollup of everything beneath it. */
  dirs: Map<string, DirRollup>;
}

/**
 * Build the two lookups the tree renderer needs, in one pass per entry.
 *
 * Directory rollups are derived by walking each changed path's ancestors up to
 * (and excluding) the repo root, so a collapsed `? build/` entry and a deep
 * `src/a/b/c.ts` both light up every directory above them.
 */
export function buildStatusIndex(status: GitStatus | null): StatusIndex {
  const byPath = new Map<string, GitEntry>();
  const dirs = new Map<string, DirRollup>();
  if (!status) return { byPath, dirs };

  const rootKey = pathKey(status.repoRoot);
  for (const entry of status.entries) {
    const key = pathKey(entry.path);
    byPath.set(key, entry);
    // An untracked directory is both an entry and an ancestor of its contents.
    if (entry.isDir) {
      const own = dirs.get(key) ?? { count: 0, untracked: false };
      own.untracked = own.untracked || entry.untracked;
      dirs.set(key, own);
    }
    let dir = parentKey(key);
    while (dir && dir !== rootKey && dir.length > rootKey.length) {
      const roll = dirs.get(dir) ?? { count: 0, untracked: false };
      roll.count += 1;
      dirs.set(dir, roll);
      dir = parentKey(dir);
    }
    // Count against the root too, so the header can show a total.
    const rootRoll = dirs.get(rootKey) ?? { count: 0, untracked: false };
    rootRoll.count += 1;
    dirs.set(rootKey, rootRoll);
  }
  return { byPath, dirs };
}

function parentKey(key: string): string {
  const i = key.lastIndexOf("/");
  return i <= 0 ? "" : key.slice(0, i);
}

/**
 * Status of a path for display, resolving inheritance.
 *
 * A file inside a collapsed `? dir/` entry has no entry of its own — git never
 * listed it — so it inherits untracked from the nearest such ancestor.
 */
export function statusOf(index: StatusIndex, path: string): GitEntry | null {
  const key = pathKey(path);
  const own = index.byPath.get(key);
  if (own) return own;
  let dir = parentKey(key);
  while (dir) {
    const entry = index.byPath.get(dir);
    if (entry?.isDir && entry.untracked) return entry;
    dir = parentKey(dir);
  }
  return null;
}

/**
 * The single letter shown at the end of a row, or "" for no change.
 *
 * The staged side wins when both sides changed: `MM` reads as `M`, and an added
 * file the user then edited still reads as `A`, which is the more useful fact.
 */
export function statusLetter(entry: GitEntry | null): string {
  if (!entry) return "";
  if (entry.conflicted) return "U";
  if (entry.untracked) return "?";
  const letter = entry.index !== "." ? entry.index : entry.worktree;
  return letter === "." ? "" : letter;
}

/** Tailwind color class for a status letter, reusing the diff palette. */
export function statusColor(letter: string): string {
  switch (letter) {
    case "A":
      return "text-[var(--diff-add-text)]";
    case "D":
      return "text-[var(--diff-del-text)]";
    case "U":
      return "text-red-500";
    case "?":
      return "text-dim";
    default:
      // M, R, C and anything else git invents.
      return "text-amber-500";
  }
}

/** Human-readable branch label: `main ↑2 ↓1`, or the detached/empty wording. */
export function branchLabel(status: GitStatus): string {
  const parts = [status.detached ? `${status.branch} (detached)` : status.branch];
  if (status.initial) parts.push("(initial)");
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(" ");
}

/**
 * Path of `absPath` relative to the repo root, posix separators — the form
 * `git_diff` expects. Null when the path is outside the repository.
 *
 * The comparison is normalized but the result is sliced out of the original
 * string: git matches paths case-sensitively even on Windows, so the real
 * casing has to survive.
 */
export function relPathOf(status: GitStatus | null, absPath: string): string | null {
  if (!status) return null;
  const rootKey = pathKey(status.repoRoot).replace(/\/+$/, "");
  const key = pathKey(absPath);
  if (!key.startsWith(`${rootKey}/`)) return null;
  return absPath.replace(/\\/g, "/").slice(rootKey.length + 1);
}

/** Changed entries grouped by their parent directory, for the "changes only" list. */
export function groupByDir(status: GitStatus): Array<{ dir: string; entries: GitEntry[] }> {
  const groups = new Map<string, GitEntry[]>();
  for (const entry of status.entries) {
    const i = entry.relPath.lastIndexOf("/");
    const dir = i < 0 ? "" : entry.relPath.slice(0, i);
    const list = groups.get(dir);
    if (list) list.push(entry);
    else groups.set(dir, [entry]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, entries]) => ({
      dir,
      entries: entries.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    }));
}

/**
 * Parse a unified diff (`git diff` output) into `DiffView` rows.
 *
 * Only hunk bodies become rows: the `diff --git` / `index` / `+++` / `---`
 * preamble is metadata, and `\ No newline at end of file` is a note about the
 * previous row rather than a row. Each `@@` header emits one `skip` row so the
 * gap between hunks is visible — except before the first hunk, where there is
 * no gap to show.
 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  // Drop exactly the final newline, so it cannot be mistaken for a diff row
  // that happens to be an empty context line.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (const line of body.split("\n")) {
    // A CRLF file's diff rows carry the `\r`. It belongs to the line
    // terminator, not the content, and `white-space: pre` would render it as a
    // second line break.
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (inHunk) out.push({ kind: "skip", text: "..." });
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // preamble
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      out.push({ kind: "add", newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    } else if (raw === "") {
      // A context line stripped of its leading space by something downstream.
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: "" });
    }
    // Anything else (a second file's preamble) is skipped.
  }
  return out;
}
