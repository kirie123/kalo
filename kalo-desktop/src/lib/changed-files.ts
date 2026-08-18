/**
 * Aggregation for the end-of-turn "changed files" card.
 *
 * One agent run can touch the same file several times (edit, edit, write);
 * the card wants the net result, one row per file. Everything here is pure so
 * the counting rules stay testable and out of the store.
 *
 * Only `write` and `edit` count. Any tool that changes files by other means
 * (bash, a subagent's inner calls) is deliberately out of scope: we would be
 * guessing, and a wrong file list is worse than a short one.
 */

import { diffStats, extractDiff } from "../components/DiffView";
import type { ToolCallRecord } from "./chat-store";

export interface ChangedFile {
  /** Display path, relative to the working directory when possible. */
  path: string;
  /** Absolute path, for reading the file back in the viewer. */
  fullPath: string;
  added: number;
  /** undefined = unknown (an old engine's write); the UI then omits "-N". */
  removed?: number;
  /** How many calls in this run touched the file. */
  edits: number;
  /** The file did not exist before this run. */
  created: boolean;
  /** Most recent edit diff, for inline review. */
  lastDiff?: string;
}

export interface ChangeSummary {
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}

/** Accumulator keyed by display path; order of first appearance is preserved. */
export type ChangeAccumulator = Map<string, ChangedFile>;

export function createAccumulator(): ChangeAccumulator {
  return new Map();
}

/** Path as the card shows it: relative to cwd, with forward slashes. */
export function displayPath(raw: string, cwd: string): string {
  const path = raw.replace(/\\/g, "/");
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return path;
  // Windows paths are case-insensitive; compare folded but keep the original.
  if (path.toLowerCase().startsWith(base.toLowerCase() + "/")) return path.slice(base.length + 1);
  return path;
}

/** True for `/abs`, `C:/abs` and UNC paths — everything else is cwd-relative. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:\//.test(path);
}

/** Absolute path, as the tool would have resolved it, for reading the file back. */
export function fullPath(raw: string, cwd: string): string {
  const path = raw.replace(/\\/g, "/");
  if (isAbsolute(path)) return path;
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return base ? `${base}/${path}` : path;
}

/**
 * Fold one finished tool call into the accumulator. Non-file tools, failed
 * calls and calls without a usable path are ignored.
 */
export function accumulate(acc: ChangeAccumulator, rec: ToolCallRecord, cwd: string): void {
  if (rec.status !== "success") return;
  if (rec.toolName !== "write" && rec.toolName !== "edit") return;
  const raw = rec.args?.path ?? rec.args?.file_path;
  if (typeof raw !== "string" || !raw) return;

  const key = displayPath(raw, cwd);
  const prev = acc.get(key);
  const next: ChangedFile = prev ?? {
    path: key,
    fullPath: fullPath(raw, cwd),
    added: 0,
    removed: 0,
    edits: 0,
    created: false,
  };

  if (rec.toolName === "edit") {
    const diff = extractDiff(rec.result);
    if (diff) {
      const { add, del } = diffStats(diff);
      next.added += add;
      next.removed = (next.removed ?? 0) + del;
      next.lastDiff = diff;
    }
    // An edit without a diff still counts as a touch, just with no numbers.
  } else {
    const details = rec.result?.details as { created?: boolean; added?: number; removed?: number } | undefined;
    if (typeof details?.added === "number") {
      next.added += details.added;
      next.removed = (next.removed ?? 0) + (details.removed ?? 0);
    } else {
      // Old engine, or a write whose previous content was unreadable: count the
      // written lines and admit we cannot know what was replaced.
      const content = rec.args?.content;
      if (typeof content === "string") next.added += countLines(content);
      next.removed = undefined;
    }
    // Only the first touch can have created the file.
    if (details?.created === true && next.edits === 0) next.created = true;
  }

  next.edits += 1;
  acc.set(key, next);
}

/** Snapshot the accumulator as the entry the timeline stores. */
export function summarize(acc: ChangeAccumulator): ChangeSummary {
  const files = [...acc.values()].map((f) => ({ ...f }));
  return {
    files,
    totalAdded: files.reduce((n, f) => n + f.added, 0),
    totalRemoved: files.reduce((n, f) => n + (f.removed ?? 0), 0),
  };
}

/** Lines in a text, where a trailing newline terminates the last line. */
function countLines(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}
