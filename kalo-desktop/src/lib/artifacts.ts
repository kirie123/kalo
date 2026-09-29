/**
 * Pure logic for the present_files tool: parsing, aggregation, and the
 * live auto-open emitter.
 *
 * Kept free of Tauri IPC so the parsing rules are unit-testable and the
 * emitter can be subscribed from any component without store coupling.
 * chat-store calls handleSpecialToolResult() on tool_execution_end; the
 * card reads ArtifactSummary from the timeline entry; FilePanel subscribes
 * to autoOpenEmitter for the one-shot live side effect.
 *
 * Design: doc/2026-09-28-产物呈现通道.md
 */

import type { FileKind } from "./file-kind";
import type { TodoItem } from "./timeline";
import type { ToolCallRecord } from "./timeline";

// ============================================================================
// Wire types (mirror of kalo-harness present-files/index.ts ArtifactItem)
// ============================================================================

export interface ArtifactItem {
  kind: "file" | "url";
  /** Absolute path (file) or original URL (url). */
  path: string;
  /** Display name: file basename or URL's host + last path segment. */
  name: string;
  /** Render bucket for local files, from the engine's extension-based classification. */
  fileKind?: FileKind;
  /** File size in bytes, when stat succeeded on the engine side. */
  bytes?: number;
  /** True when the engine could not stat the path. */
  missing?: true;
  /** The first entry after deduplication. Opened automatically on live arrival. */
  primary: boolean;
}

interface RawDetails {
  artifacts?: unknown;
  explanation?: string;
}

// ============================================================================
// Parsed summary (used by ArtifactsEntry in timeline + ArtifactsCard)
// ============================================================================

export interface ArtifactSummary {
  items: ArtifactItem[];
  primary: ArtifactItem | null;
  explanation?: string;
}

function isArtifactItem(v: unknown): v is ArtifactItem {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    (a.kind === "file" || a.kind === "url") &&
    typeof a.path === "string" &&
    typeof a.name === "string" &&
    typeof a.primary === "boolean"
  );
}

/**
 * Parse the details payload of a present_files tool result into a summary.
 * Returns null when the result is not a valid present_files call.
 */
export function parseArtifacts(rec: ToolCallRecord): ArtifactSummary | null {
  if (rec.toolName !== "present_files" || rec.status === "error") return null;
  const raw = rec.result?.details as RawDetails | undefined;
  if (!raw) return null;
  if (!Array.isArray(raw.artifacts)) return null;
  const items = raw.artifacts.filter(isArtifactItem);
  if (items.length === 0) return null;
  return {
    items,
    primary: items.find((a) => a.primary) ?? null,
    explanation: typeof raw.explanation === "string" ? raw.explanation : undefined,
  };
}

// ============================================================================
// Session-level aggregation (for the right-side 产物 bar in FilePanel)
// ============================================================================

/**
 * Aggregate all present_files calls in a session into one deduped list,
 * latest declaration of a given path wins, original order preserved.
 * Used by FilePanel to build the "产物" section.
 */
export function sessionArtifacts(records: ToolCallRecord[]): ArtifactItem[] {
  const map = new Map<string, ArtifactItem>();
  for (const rec of records) {
    const s = parseArtifacts(rec);
    if (!s) continue;
    for (const item of s.items) {
      map.set(item.path, item);
    }
  }
  return Array.from(map.values());
}

// ============================================================================
// Auto-open emitter (live-only; history replay never calls this)
// ============================================================================

type AutoOpenHandler = (item: ArtifactItem) => void;

const handlers = new Set<AutoOpenHandler>();

/** Subscribe to live auto-open events. Returns an unsubscribe function. */
export function onAutoOpen(fn: AutoOpenHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/** Emit a live auto-open event. Called only from chat-store's live tool_execution_end path. */
export function emitAutoOpen(item: ArtifactItem): void {
  for (const fn of handlers) fn(item);
}

// ============================================================================
// Shared tool-result handler (extracts todo_write + present_files from chat-store)
// ============================================================================

interface ToolResultActions {
  setTodos(todos: TodoItem[]): void;
  pushArtifacts(summary: ArtifactSummary): void;
}

/**
 * Handle per-tool side effects for tool_execution_end. Extracted here so
 * chat-store delegates in one line rather than growing with each new tool.
 *
 * Returns whether the primary artifact should be auto-opened (i.e. a live
 * present_files call succeeded). The caller fires emitAutoOpen if true.
 */
export function handleSpecialToolResult(
  rec: ToolCallRecord,
  actions: ToolResultActions,
): void {
  if (rec.toolName === "todo_write" && rec.status !== "error") {
    const todos = readTodos(rec.result);
    if (todos) actions.setTodos(todos);
  }
  if (rec.toolName === "present_files" && rec.status !== "error") {
    const summary = parseArtifacts(rec);
    if (summary) {
      actions.pushArtifacts(summary);
      if (summary.primary) emitAutoOpen(summary.primary);
    }
  }
}

// ---------------------------------------------------------------------------
// todo_write helper (moved here from chat-store to free ratchet lines)
// ---------------------------------------------------------------------------

function readTodos(result: unknown): TodoItem[] | null {
  const todos = (result as any)?.details?.todos;
  if (!Array.isArray(todos)) return null;
  const ok = todos.every(
    (t: unknown) =>
      t &&
      typeof (t as any).content === "string" &&
      ((t as any).status === "pending" ||
        (t as any).status === "in_progress" ||
        (t as any).status === "completed"),
  );
  return ok ? (todos as TodoItem[]) : null;
}
