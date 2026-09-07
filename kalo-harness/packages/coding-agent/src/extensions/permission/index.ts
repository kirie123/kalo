/**
 * Permission mode extension — gates tool calls behind a per-session mode.
 *
 * Three modes, selected by the user (see MODE_LABELS): read-only asks before
 * every write and every shell command, workspace-write asks only for writes
 * that leave the workspace, full-auto asks for nothing. A short red line of
 * irreversible operations is refused in all three and cannot be approved.
 *
 * All judgement lives in the pure modules next to this file (policy/danger/
 * paths/state/prompt); this file only wires them to the extension API. It hooks
 * `tool_call`, which the agent loop invokes after schema validation and before
 * execution — the hook is async and receives the abort signal, so awaiting an
 * approval dialog inside it is supported.
 *
 * With no dialog-capable UI (`ctx.hasUI === false`: print/json runs, scheduled
 * jobs) an "ask" verdict collapses to a refusal rather than hanging forever.
 *
 * Design: doc/2026-09-07-权限模式.md
 */

import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { decide } from "./policy.ts";
import { cancelledReason, rejectionReason, systemPromptContribution, unavailableReason } from "./prompt.ts";
import { foldGrants, foldMode } from "./state.ts";
import type { GrantScope, PermissionDecision, PermissionMode } from "./types.ts";
import { GRANT_ENTRY_TYPE, isPermissionMode, MODE_ENTRY_TYPE, MODE_LABELS, PERMISSION_MODES } from "./types.ts";

const ALLOW_ONCE = "允许一次";
const ALLOW_SESSION = "本会话允许同类";
const REJECT = "拒绝";

/** Shorten a shell command for a dialog title without hiding the dangerous tail. */
function forDisplay(text: string): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	if (collapsed.length <= 200) return collapsed;
	return `${collapsed.slice(0, 120)} … ${collapsed.slice(-60)}`;
}

export default function permissionExtension(pi: ExtensionAPI): void {
	/** Effective mode for the live session; undefined until session_start pins it. */
	let mode: PermissionMode | undefined;
	let grants: GrantScope[] = [];

	pi.registerFlag("permission-mode", {
		description: `Initial permission mode (${PERMISSION_MODES.join(" | ")})`,
		type: "string",
	});

	function defaultMode(cwd: string): PermissionMode {
		const flag = pi.getFlag("permission-mode");
		if (isPermissionMode(flag)) return flag;
		try {
			return SettingsManager.create(cwd, getAgentDir()).getDefaultPermissionMode();
		} catch {
			// A malformed settings.json must not make every session unusable.
			return "workspace-write";
		}
	}

	function current(): PermissionMode {
		return mode ?? "workspace-write";
	}

	/**
	 * Pin the mode into the session log on creation, and restore it on reload.
	 *
	 * A session that already carries a mode entry keeps it: the user's current
	 * default must not rewrite the meaning of an old session that is merely
	 * being resumed.
	 */
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const recorded = foldMode(entries);
		if (recorded !== undefined) {
			mode = recorded;
			grants = foldGrants(entries);
			return;
		}
		const flag = pi.getFlag("permission-mode");
		mode = defaultMode(ctx.cwd);
		grants = [];
		pi.appendEntry(MODE_ENTRY_TYPE, { mode, source: isPermissionMode(flag) ? "flag" : "default" });
	});

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${systemPromptContribution(current())}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const decision = decide({
			mode: current(),
			tool: event.toolName,
			input: event.input as Record<string, unknown>,
			workspace: ctx.cwd,
			agentDir: getAgentDir(),
			grants,
		});

		if (decision.kind === "allow") return undefined;
		if (decision.kind === "deny") return { block: true, reason: decision.reason };

		return await ask(decision, ctx);
	});

	async function ask(
		decision: Extract<PermissionDecision, { kind: "ask" }>,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> {
		const activeMode = current();
		if (!ctx.hasUI) {
			return { block: true, reason: unavailableReason(activeMode, decision.reason, decision.subject) };
		}

		const isBash = decision.reason === "bash-in-readonly";
		const heading = isBash ? "审批：执行命令" : "审批：写入文件";
		const detail = isBash
			? forDisplay(decision.subject)
			: `${decision.subject}${decision.reason === "write-outside-workspace" ? "\n（工作区外）" : ""}`;
		const options = decision.grantable ? [ALLOW_ONCE, ALLOW_SESSION, REJECT] : [ALLOW_ONCE, REJECT];

		// No timeout: waiting for a human is the correct behaviour here, and an
		// auto-dismiss would turn approval into a silent failure. The agent's
		// abort signal still closes the dialog when the user stops the turn.
		const choice = await ctx.ui.select(`${heading}\n\n${detail}`, options, { signal: ctx.signal });

		if (choice === ALLOW_ONCE) return undefined;
		if (choice === ALLOW_SESSION && decision.grantable) {
			grants = [...grants, decision.grantable];
			pi.appendEntry(GRANT_ENTRY_TYPE, decision.grantable);
			return undefined;
		}
		if (choice === REJECT) {
			return { block: true, reason: rejectionReason(activeMode, decision.reason, decision.subject) };
		}
		// Dismissed without an answer (aborted turn, closed dialog): fail closed.
		return { block: true, reason: cancelledReason(decision.subject) };
	}

	/** Switch modes, invalidating grants issued under the previous mode. */
	function switchTo(next: PermissionMode): boolean {
		if (next === current()) return false;
		mode = next;
		grants = [];
		pi.appendEntry(MODE_ENTRY_TYPE, { mode: next, source: "user" });
		pi.appendEntry(GRANT_ENTRY_TYPE, { reset: true });
		return true;
	}

	pi.registerCommand("permission", {
		description: "查看或切换权限模式",
		getArgumentCompletions: (prefix) =>
			PERMISSION_MODES.filter((name) => name.startsWith(prefix)).map((name) => ({
				value: name,
				label: `${MODE_LABELS[name].label} — ${MODE_LABELS[name].hint}`,
			})),
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested === "") {
				const lines = PERMISSION_MODES.map((name) => {
					const marker = name === current() ? "*" : " ";
					return `${marker} ${name} — ${MODE_LABELS[name].label}：${MODE_LABELS[name].hint}`;
				});
				ctx.ui.notify(`当前权限模式：${current()}\n${lines.join("\n")}`, "info");
				return;
			}
			if (!isPermissionMode(requested)) {
				ctx.ui.notify(`未知权限模式：${requested}（可选：${PERMISSION_MODES.join(" / ")}）`, "error");
				return;
			}
			if (switchTo(requested)) {
				ctx.ui.notify(`权限模式已切换为 ${requested}（${MODE_LABELS[requested].label}）`, "info");
			}
		},
	});
}

/** Read the effective mode; used by the RPC layer to report session state. */
export { foldMode } from "./state.ts";
export type { PermissionMode, PermissionModeDisplay } from "./types.ts";
export { PERMISSION_MODES } from "./types.ts";
