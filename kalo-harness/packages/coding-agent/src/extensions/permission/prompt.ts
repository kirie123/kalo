/**
 * Model-facing text: the system-prompt contribution per mode and the refusal
 * wording handed back as a tool error.
 *
 * Kept separate from the wiring so the exact strings are reviewable and
 * testable. All of it is appended after the base prompt, so switching modes
 * never rewrites the prefix and the KV cache survives.
 */

import type { AskReason, PermissionMode } from "./types.ts";

const CONTRIBUTIONS: Record<PermissionMode, string> = {
	"read-only":
		"Permission mode: read-only. Every file write and every shell command requires the user's " +
		"per-operation approval. Batch related changes and explain what you intend to do before writing, " +
		"so the user has fewer prompts to review. A small set of irreversible operations is refused " +
		"outright and cannot be approved.",
	"workspace-write":
		"Permission mode: workspace-write. Writes inside the workspace and shell commands run without " +
		"approval; writes outside the workspace require the user's approval. Prefer staying inside the " +
		"workspace. A small set of irreversible operations is refused outright and cannot be approved.",
	"full-auto":
		"Permission mode: full auto. Tool calls run without approval. A small set of irreversible " +
		"operations is refused outright and cannot be approved.",
};

/** The block appended to the system prompt for the session's current mode. */
export function systemPromptContribution(mode: PermissionMode): string {
	return `## Permission mode\n\n${CONTRIBUTIONS[mode]}`;
}

/** What the model is told when the user rejects an approval prompt. */
export function rejectionReason(mode: PermissionMode, reason: AskReason, subject: string): string {
	const what = reason === "bash-in-readonly" ? `the shell command \`${subject}\`` : `the write to ${subject}`;
	return (
		`Blocked by permission mode "${mode}": the user rejected ${what}. ` +
		"Do not retry the same call. Explain what you intended and ask how to proceed."
	);
}

/** What the model is told when nobody could be asked (headless run). */
export function unavailableReason(mode: PermissionMode, reason: AskReason, subject: string): string {
	const what = reason === "bash-in-readonly" ? `the shell command \`${subject}\`` : `the write to ${subject}`;
	return (
		`Blocked by permission mode "${mode}": ${what} needs approval, but this run has no user to ask. ` +
		"Do not retry. Report that the task needs a less restrictive permission mode to continue."
	);
}

/** What the model is told when the user aborted the turn while being asked. */
export function cancelledReason(subject: string): string {
	return `Approval for ${subject} was cancelled because the turn was interrupted. Stop and wait for the user.`;
}
