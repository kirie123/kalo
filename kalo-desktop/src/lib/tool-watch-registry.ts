/**
 * Live snapshots of running tool calls, addressed by tool call id.
 *
 * The terminal's watch tabs mirror a bash command's output. That output lives
 * in a chat-store runtime — possibly a *parked* one (the user switched
 * sessions while a long command kept running), which no component can read.
 * chat-store therefore publishes every `tool_execution_update` and the final
 * `tool_execution_end` here, and `TerminalWatchTab` subscribes.
 *
 * Keyed by tool call id alone: engine call ids are globally unique and a watch
 * tab belongs to exactly one call. No DOM, no IPC, no React — the hook at the
 * bottom is the only React surface.
 */

import { useSyncExternalStore } from "react";

export interface ToolWatchSnapshot {
  status: "running" | "success" | "error";
  partialResult?: unknown;
  result?: unknown;
}

const entries = new Map<string, ToolWatchSnapshot>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/**
 * Record what the row already knows when a watch tab is opened (live row, or
 * a replayed history row whose events are long gone). Never overwrites a live
 * entry: the tab must not regress to stale data.
 */
export function seedToolWatch(id: string, snapshot: ToolWatchSnapshot): void {
  if (entries.has(id)) return;
  entries.set(id, snapshot);
  notify();
}

/** Merge one live update into an entry and wake subscribers. */
export function publishToolWatch(id: string, patch: Partial<ToolWatchSnapshot>): void {
  const prev = entries.get(id);
  entries.set(id, { ...(prev ?? { status: "running" }), ...patch });
  notify();
}

export function getToolWatch(id: string): ToolWatchSnapshot | undefined {
  return entries.get(id);
}

/** Drop one entry (its mirror tab closed; the row keeps its own copy). */
export function clearToolWatch(id: string): void {
  if (entries.delete(id)) notify();
}

/**
 * chat-store's publish point for every tool call. Only bash has a mirror, and
 * keeping every read/edit payload of every session alive in this module-level
 * map is a leak with no reader.
 */
export function publishBashWatch(toolName: string, id: string, patch: Partial<ToolWatchSnapshot>): void {
  if (toolName === "bash") publishToolWatch(id, patch);
}

export function subscribeToolWatch(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * One tool call's latest snapshot. `getToolWatch` returns the stored object —
 * identity is stable until a publish replaces it, which is exactly what
 * `useSyncExternalStore` needs.
 */
export function useToolWatch(id: string): ToolWatchSnapshot | undefined {
  return useSyncExternalStore(subscribeToolWatch, () => getToolWatch(id));
}