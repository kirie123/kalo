/**
 * The permission decision table — one pure function, zero I/O.
 *
 * Every mode/tool/path combination resolves here, which is what makes the
 * behaviour testable without an agent, a session, or a UI.
 *
 * Design: doc/2026-09-07-权限模式.md
 */

import { dangerousCommandReason } from "./danger.ts";
import { isInside, isProtectedWrite, toAbsolute } from "./paths.ts";
import type { GrantScope, PermissionDecision, PermissionMode } from "./types.ts";

/** Tools that only observe: allowed in every mode. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "find", "request_user"]);

/** Tools whose target path is judged against the workspace. */
const WRITE_TOOLS = new Set(["write", "edit"]);

export interface DecideInput {
	mode: PermissionMode;
	tool: string;
	/** Already schema-validated tool arguments. */
	input: Record<string, unknown>;
	/** Session cwd — the workspace root. */
	workspace: string;
	/** `~/.kalo/agent`, whose credential and trust files are never writable. */
	agentDir: string;
	/** Session-scoped grants handed out from earlier approval prompts. */
	grants: readonly GrantScope[];
}

const ALLOW: PermissionDecision = { kind: "allow" };

function pathOf(input: Record<string, unknown>): string | undefined {
	const value = input.path;
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function commandOf(input: Record<string, unknown>): string | undefined {
	const value = input.command;
	return typeof value === "string" ? value : undefined;
}

function isGranted(grants: readonly GrantScope[], tool: string, target: string): boolean {
	return grants.some((grant) => grant.tool === tool && isInside(target, grant.dir));
}

/**
 * Decide one tool call.
 *
 * Unknown tools (MCP servers, subagent, extension-registered tools) are
 * allowed: this table cannot know their side effects, and refusing everything
 * unknown would break every MCP integration. Guarding them needs per-tool
 * metadata, which does not exist yet.
 */
export function decide(request: DecideInput): PermissionDecision {
	const { mode, tool, input, workspace, agentDir, grants } = request;

	if (tool === "bash") {
		const command = commandOf(input);
		if (command === undefined) return ALLOW;
		const danger = dangerousCommandReason(command);
		if (danger !== undefined) {
			return {
				kind: "deny",
				reason: `refused unconditionally: ${danger}. This cannot be approved in any permission mode.`,
			};
		}
		// Read-only asks for every command: the engine cannot tell `ls` from
		// `rm -rf` statically, so refusing all of them would make the mode
		// useless while allowing all of them would make its name a lie.
		if (mode === "read-only") {
			return { kind: "ask", reason: "bash-in-readonly", subject: command, grantable: undefined };
		}
		return ALLOW;
	}

	if (WRITE_TOOLS.has(tool)) {
		const relativeOrAbsolute = pathOf(input);
		if (relativeOrAbsolute === undefined) return ALLOW;
		const target = toAbsolute(relativeOrAbsolute, workspace);

		if (isProtectedWrite(target, agentDir)) {
			return {
				kind: "deny",
				reason: `refused unconditionally: ${target} holds credentials or engine configuration. Ask the user to change it through the settings UI.`,
			};
		}

		const inside = isInside(target, workspace);

		if (mode === "full-auto") return ALLOW;
		if (mode === "workspace-write" && inside) return ALLOW;
		if (isGranted(grants, tool, target)) return ALLOW;

		// Read-only never offers a session grant: once a class of writes is
		// allowed the mode is no longer read-only, and its name would lie. The
		// honest way out is switching modes, which is visible in the UI.
		const grantable = mode === "read-only" ? undefined : { tool, dir: parentDir(target) };
		return {
			kind: "ask",
			reason: mode === "read-only" ? "write-in-readonly" : "write-outside-workspace",
			subject: target,
			grantable,
		};
	}

	if (READ_ONLY_TOOLS.has(tool)) return ALLOW;

	return ALLOW;
}

/** The directory a per-directory grant would cover. */
function parentDir(target: string): string {
	const normalized = target.replaceAll("\\", "/");
	const cut = normalized.lastIndexOf("/");
	return cut <= 0 ? target : target.slice(0, cut);
}
