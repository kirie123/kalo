/**
 * Permission mode types — the vocabulary shared by the pure deciders and the
 * extension wiring.
 *
 * Design: doc/2026-09-07-权限模式.md
 */

/** The three user-selectable modes. */
export const PERMISSION_MODES = ["read-only", "workspace-write", "full-auto"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * What the client may display as "current". `custom` is derived-only: it never
 * appears in a session entry and the user cannot select it. Nothing produces it
 * today (there is a single knob), but the shape is fixed now so adding a second
 * independent knob later does not change the desktop contract.
 */
export type PermissionModeDisplay = PermissionMode | "custom";

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** One-line user-facing label and explanation per mode. */
export const MODE_LABELS: Record<PermissionMode, { label: string; hint: string }> = {
	"read-only": { label: "只读", hint: "只看不改；每次改动逐一审批" },
	"workspace-write": { label: "工作区", hint: "工作区内自由读写；越界写需审批" },
	"full-auto": { label: "全自动", hint: "不打扰；仅拦不可挽回的操作" },
};

/**
 * The verdict for one tool call. `ask` means "prompt the user"; with no user
 * available it collapses to a refusal (fail closed), decided by the caller that
 * owns the UI, not here.
 */
export type PermissionDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: AskReason; subject: string; grantable: GrantScope | undefined }
	| { kind: "deny"; reason: string };

/** Why approval is being requested — drives the prompt wording. */
export type AskReason = "write-in-readonly" | "write-outside-workspace" | "bash-in-readonly";

/**
 * A session-scoped grant the user may hand out from an approval prompt.
 * `dir` covers "this tool, anywhere under this directory".
 */
export interface GrantScope {
	tool: string;
	dir: string;
}

/** Session entry payloads (customType `permission-mode` / `permission-grant`). */
export interface PermissionModeEntry {
	mode: PermissionMode;
	source: "default" | "user" | "flag";
}

export type PermissionGrantEntry = { tool: string; dir: string } | { reset: true };

export const MODE_ENTRY_TYPE = "permission-mode";
export const GRANT_ENTRY_TYPE = "permission-grant";
