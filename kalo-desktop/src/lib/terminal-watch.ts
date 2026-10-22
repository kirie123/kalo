/**
 * Feeding a live tool snapshot into a terminal view (pure logic).
 *
 * The engine's partial snapshots are a *rolling tail*: while the output is
 * short they grow monotonically — the new snapshot starts with the previous
 * one — but once the accumulator evicts old bytes the new snapshot is no
 * longer an extension. Writing "the difference" then would splice two
 * unrelated strings together, so that case is a reset.
 */

import { contentText } from "./tool-output";
import type { ToolWatchSnapshot } from "./tool-watch-registry";

export type WatchFeed =
  | { mode: "append"; text: string }
  | { mode: "reset"; text: string };

/**
 * What one update should write, given everything already written.
 * `null` = nothing changed (no write, no churn).
 */
export function watchFeed(prev: string, next: string): WatchFeed | null {
  if (next === prev) return null;
  if (next.startsWith(prev)) return { mode: "append", text: next.slice(prev.length) };
  return { mode: "reset", text: next };
}

/**
 * Text a watch tab shows for one snapshot. The settled result wins — it
 * carries the truncation footer / error line the partial lacks — and the
 * partial's text blocks are the fallback. Never JSON: a running bash's empty
 * partial (`{"content": []}`) must not render as a debug payload.
 */
export function watchText(snapshot: ToolWatchSnapshot | undefined): string {
  if (!snapshot) return "";
  return contentText(snapshot.result) || contentText(snapshot.partialResult);
}