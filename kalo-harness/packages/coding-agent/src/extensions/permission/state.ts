/**
 * Session-state folding — pure, so "what mode is this session in" is testable
 * without a session manager.
 *
 * The session log IS the state: the effective mode is the last `permission-mode`
 * entry, and grants are the entries after the most recent reset. Nothing is
 * cached elsewhere, so a reloaded or branched session recovers its permission
 * state for free.
 */

import type { GrantScope, PermissionGrantEntry, PermissionMode, PermissionModeEntry } from "./types.ts";
import { GRANT_ENTRY_TYPE, isPermissionMode, MODE_ENTRY_TYPE } from "./types.ts";

/** The shape this module needs from a session entry; matches `CustomEntry`. */
export interface CustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function isReset(data: PermissionGrantEntry): data is { reset: true } {
	return "reset" in data && data.reset === true;
}

/**
 * The effective mode, or undefined when the session has no mode entry yet
 * (a brand-new session, before pinning).
 */
export function foldMode(entries: readonly CustomEntryLike[]): PermissionMode | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as CustomEntryLike;
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		const data = entry.data as PermissionModeEntry | undefined;
		if (data && isPermissionMode(data.mode)) return data.mode;
	}
	return undefined;
}

/**
 * Session grants still in force. A reset entry (appended on every mode switch)
 * invalidates everything before it: a grant was given under the old mode's
 * meaning and must not survive into a different one.
 */
export function foldGrants(entries: readonly CustomEntryLike[]): GrantScope[] {
	const grants: GrantScope[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GRANT_ENTRY_TYPE) continue;
		const data = entry.data as PermissionGrantEntry | undefined;
		if (!data) continue;
		if (isReset(data)) {
			grants.length = 0;
			continue;
		}
		if (typeof data.tool === "string" && typeof data.dir === "string") {
			grants.push({ tool: data.tool, dir: data.dir });
		}
	}
	return grants;
}
