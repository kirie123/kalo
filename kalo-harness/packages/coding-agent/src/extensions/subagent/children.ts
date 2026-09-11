/**
 * Child agent registry — resident sessions that can be resumed.
 *
 * A child used to be strictly single-shot: `await session.prompt()` ran one
 * loop, the final text went back to the parent, and the session became
 * unreachable. Anything that cut the run short (a provider error, the idle
 * watchdog) threw away all of the work with it.
 *
 * Children now stay resident here after a turn ends, so the parent can hand
 * them another message. The map is a cache, not the source of truth: history
 * lives in a real session file (see childSessionPath), so an evicted — or even
 * a previous-process — child can still be resumed by reading it back.
 *
 * Design: doc/2026-09-11-可续写子agent与主agent派生.md
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import { getDefaultSessionDir } from "../../core/session-manager.ts";

/**
 * Max children kept in memory per engine process.
 *
 * Each handle pins an AgentSession holding a full message history, so an
 * unbounded map grows the engine's heap without limit. Eviction is cheap
 * precisely because history is on disk: a resumed-after-eviction child costs
 * one file read, not a lost conversation.
 *
 * Override with KALO_SUBAGENT_RESIDENT (integer >= 1).
 */
const DEFAULT_MAX_RESIDENT = 16;

function resolveMaxResident(): number {
	const raw = process.env.KALO_SUBAGENT_RESIDENT?.trim();
	if (!raw) return DEFAULT_MAX_RESIDENT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_RESIDENT;
	return parsed;
}

export const MAX_RESIDENT = resolveMaxResident();

/** Lifecycle state of a resident child. */
export type ChildStatus = "running" | "idle" | "stalled" | "failed" | "evicted";

export interface ChildHandle {
	/** Child id, e.g. `subagent-3`; also the session file stem. */
	id: string;
	session: AgentSession;
	status: ChildStatus;
	cwd: string;
	/** Owning parent session id — the fence for resume. */
	ownerSession: string;
	description?: string;
	tools: string[];
	/** Turns completed so far, across every resume. */
	turns: number;
	createdAt: number;
	lastActiveAt: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Directory holding one parent's child sessions.
 *
 * Children live under the parent's own cwd bucket rather than a separate
 * top-level directory. Two reasons: deleting a parent conversation takes its
 * children with it instead of orphaning them, and a flat `subagent-sessions/`
 * would reproduce the unreadable hundred-bucket sprawl the sessions directory
 * already has.
 *
 * Nesting `<parentSessionId>` matters because one cwd bucket holds many
 * parent sessions; without it every parent's children would pile into one
 * directory. It also fences resume: another parent cannot spell this path.
 *
 * Safe from the desktop's conversation list: both scanners are non-recursive
 * (engine reads the bucket with one readdirSync, the desktop walks root then
 * bucket and takes only `.jsonl` files), so a subdirectory is skipped by both.
 * A regression test guards this.
 */
export function childSessionDir(cwd: string, parentSessionId: string, agentDir?: string): string {
	const bucket = agentDir ? getDefaultSessionDir(cwd, agentDir) : getDefaultSessionDir(cwd);
	return join(bucket, "subagent", parentSessionId);
}

/**
 * Locate a child's session file, or undefined when it has none yet.
 *
 * SessionManager names files `<timestamp>_<sessionId>.jsonl` and owns that
 * choice, so the path cannot be predicted from the child id alone — it can
 * only be recognised by the `_<childId>.jsonl` suffix. Assuming a bare
 * `<childId>.jsonl` here silently broke revive: the file always existed under
 * a different name, so resume-after-eviction reported "unknown child".
 */
export function findChildSessionFile(
	cwd: string,
	parentSessionId: string,
	childId: string,
	agentDir?: string,
): string | undefined {
	const dir = childSessionDir(cwd, parentSessionId, agentDir);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// No directory yet: this parent has never spawned a child here.
		return undefined;
	}
	const suffix = `_${childId}.jsonl`;
	// Newest wins if a child id somehow has several files (e.g. a reused id
	// across engine restarts): the latest timestamp sorts last.
	const matches = entries.filter((f) => f.endsWith(suffix)).sort();
	const chosen = matches[matches.length - 1];
	return chosen ? join(dir, chosen) : undefined;
}

/** Markdown transcript for one child, beside its session file. */
export function childTranscriptPath(cwd: string, parentSessionId: string, childId: string, agentDir?: string): string {
	return join(childSessionDir(cwd, parentSessionId, agentDir), `${childId}.md`);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const children = new Map<string, ChildHandle>();
let childSeq = 0;

/** Next child id. Ids are per-process and monotonic, matching job id style. */
export function nextChildId(): string {
	childSeq += 1;
	return `subagent-${childSeq}`;
}

export function register(handle: ChildHandle): void {
	children.set(handle.id, handle);
	evictIfNeeded();
}

/**
 * Look up a child the caller is allowed to touch.
 *
 * A child owned by another parent session is reported as absent rather than
 * forbidden: ids are predictable (`subagent-N`), so a distinct error would
 * leak whether some other conversation has that child.
 */
export function lookup(id: string, ownerSession: string): ChildHandle | undefined {
	const handle = children.get(id);
	if (!handle) return undefined;
	if (handle.ownerSession !== ownerSession) return undefined;
	return handle;
}

/** True when a child id has an on-disk session for this parent. */
export function hasPersisted(cwd: string, parentSessionId: string, childId: string, agentDir?: string): boolean {
	return findChildSessionFile(cwd, parentSessionId, childId, agentDir) !== undefined;
}

export function forget(id: string): void {
	children.delete(id);
}

/** Snapshot for tests and diagnostics; never hands out the live map. */
export function residentIds(): string[] {
	return [...children.keys()];
}

/** Test seam: drop all state between cases. */
export function resetRegistry(): void {
	children.clear();
	childSeq = 0;
}

/**
 * Evict least-recently-active idle children down to MAX_RESIDENT.
 *
 * Only non-running children are candidates — evicting a running child would
 * strand its in-flight turn. If every resident child is running, the map is
 * allowed to exceed the cap rather than break live work; the overflow drains
 * as those turns finish.
 */
function evictIfNeeded(): void {
	if (children.size <= MAX_RESIDENT) return;
	const candidates = [...children.values()]
		.filter((c) => c.status !== "running")
		.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
	let excess = children.size - MAX_RESIDENT;
	for (const candidate of candidates) {
		if (excess <= 0) break;
		candidate.status = "evicted";
		children.delete(candidate.id);
		excess--;
	}
}

/** Exported for unit tests that need to drive eviction directly. */
export const _internals = { evictIfNeeded };
