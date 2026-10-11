/**
 * Pure logic for the present_files tool: parsing, aggregation, and the live
 * auto-open side effect.
 *
 * Kept free of Tauri IPC so the parsing rules are unit-testable. chat-store
 * calls handleSpecialToolResult() on live tool_execution_end; the card reads
 * ArtifactSummary from the timeline entry; the auto-open is recorded into the
 * *owning session's* file-panel memory, so a deliverable never pops into the
 * file area of another session (doc/2026-09-28-产物呈现通道.md § 自动打开).
 *
 * Design: doc/2026-09-28-产物呈现通道.md
 */

import type { FileKind } from "./file-kind";
import { queuePanelArtifactOpen } from "./file-panel-memory";
import type { ArtifactsEntry, TimelineEntry, TodoItem } from "./timeline";
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
// Render-layer fold: one end-of-run card per run (changes + its artifacts)
// ============================================================================

/** Merge several present_files summaries into one: deduped by path, last
 *  declaration wins, first-appearance order preserved. Same rule as the
 *  right-side 产物 bar, so both show the same list. */
export function mergeArtifactSummaries(summaries: ArtifactSummary[]): ArtifactSummary | null {
  const map = new Map<string, ArtifactItem>();
  let explanation: string | undefined;
  let primary: ArtifactItem | null = null;
  for (const s of summaries) {
    for (const item of s.items) map.set(item.path, item);
    if (s.explanation) explanation = s.explanation;
    // 最后一次声明的优先级描述最终交付物；取合并后的那一份。
    if (s.primary) primary = map.get(s.primary.path) ?? s.primary;
  }
  const items = Array.from(map.values());
  if (items.length === 0) return null;
  return { items, primary, explanation };
}

/**
 * Absorb each run's present_files summaries into that run's end-of-run changes
 * card, so the transcript shows one summary card instead of two
 * (doc/2026-09-28-产物呈现通道.md § 2026-10-11 增补).
 *
 * Runs are delimited by `user` entries: every `artifacts` entry of a turn is
 * dropped from the render list and merged onto that turn's `changes` entry
 * (`ChangesEntry.artifacts`). The timeline itself is left untouched — the right
 * panel's 产物 bar reads the raw timeline, and history replay keeps its
 * standalone cards.
 *
 * `live` = the session is still running its trailing turn. Its artifacts block
 * is held back (not rendered) because the changes card may be about to absorb
 * it; once the run settles without one (live false), the block reappears where
 * it was declared — the fallback card for runs that changed no files.
 */
export function foldRunArtifacts(timeline: TimelineEntry[], live: boolean): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let held: ArtifactsEntry[] = [];
  /** Where held entries belong in `out` once the turn ends without a card. */
  let heldAt = 0;

  const emitHeld = () => {
    if (held.length > 0) out.splice(heldAt, 0, ...held);
    held = [];
  };

  for (const entry of timeline) {
    if (entry.kind === "artifacts") {
      if (held.length === 0) heldAt = out.length;
      held.push(entry);
      continue;
    }
    if (entry.kind === "changes") {
      const artifacts = mergeArtifactSummaries(held.map((h) => h.summary));
      out.push(artifacts ? { ...entry, artifacts } : entry);
      held = [];
      continue;
    }
    if (entry.kind === "user") emitHeld(); // previous turn ended card-less
    out.push(entry);
  }

  if (!live) emitHeld();
  return out;
}

// ============================================================================
// Shared tool-result handler (extracts todo_write + present_files from chat-store)
// ============================================================================

interface ToolResultActions {
  setTodos(todos: TodoItem[]): void;
  pushArtifacts(summary: ArtifactSummary): void;
}

/** The session that issued the call: where a live auto-open has to land. */
export interface CallOwner {
  /** Session-runtime uid (ChatState.sessionUid) — the panel memory's bucket key. */
  uid: string;
  /** That session's working directory, for the memory's root baseline. */
  cwd: string;
}

/**
 * Handle per-tool side effects for tool_execution_end. Extracted here so
 * chat-store delegates in one line rather than growing with each new tool.
 *
 * A successful present_files pushes its card *and* queues its primary for
 * auto-open in `owner`'s file panel: the event carries the session it belongs
 * to, so a background session's deliverable waits for its own file area
 * instead of opening in whatever session is on screen.
 */
export function handleSpecialToolResult(
  rec: ToolCallRecord,
  actions: ToolResultActions,
  owner: CallOwner,
): void {
  if (rec.toolName === "todo_write" && rec.status !== "error") {
    const todos = readTodos(rec.result);
    if (todos) actions.setTodos(todos);
  }
  if (rec.toolName === "present_files" && rec.status !== "error") {
    const summary = parseArtifacts(rec);
    if (summary) {
      actions.pushArtifacts(summary);
      if (summary.primary) queuePanelArtifactOpen(owner.uid, owner.cwd, summary.primary);
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
