import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { resolveReadPathAsync, resolveToCwd } from "../../core/tools/path-utils.ts";
import { TaskClient } from "./client.ts";

export default function taskRuntimeExtension(pi: ExtensionAPI): void {
	const role = process.env.KALO_TASK_ROLE;
	if (role !== "router" && role !== "worker") return;
	const client = new TaskClient(process.env.KALO_TASK_ENDPOINT ?? "", process.env.KALO_TASK_TOKEN ?? "");
	const ceiling =
		role === "router"
			? ["task_context", "task_decide", "task_ask"]
			: [
					"task_context",
					"task_report",
					"task_ask",
					"read",
					"write",
					"edit",
					"ls",
					"find",
					"grep",
					...(process.env.KALO_TASK_ALLOW_SHELL === "1" ? ["bash"] : []),
				];
	// The gateway narrows the ceiling by worker profile; it can never widen it.
	const granted = process.env.KALO_TASK_TOOLS?.split(",").filter(Boolean);
	const allowed = granted ? ceiling.filter((name) => granted.includes(name)) : ceiling;
	let terminal = false;
	const result = (value: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
	});

	pi.on("session_start", async (_event, ctx) => {
		pi.setActiveTools(allowed);
		await client.request(
			"context",
			{ protocol: 1, role, sessionFile: ctx.sessionManager.getSessionFile() },
			ctx.signal,
		);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		terminal = false;
		pi.setActiveTools(allowed);
		const binding = ctx.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "kalo-task-role");
		if (binding?.type === "custom" && (binding.data as { role?: string })?.role !== role)
			throw new Error("任务会话角色不匹配");
		if (!binding) pi.appendEntry("kalo-task-role", { role });
		const context = await client.request("context", { sessionFile: ctx.sessionManager.getSessionFile() }, ctx.signal);
		const instruction =
			role === "router"
				? "你是 Router，只负责接单。保留用户原意，确定可核验目标与验收条件，然后调用 task_decide(create)。确实无法判断范围时用 task_ask。没有可执行委托时用 ignore 并说明理由。不要执行业务，不自行扩大范围。"
				: "你是独立任务 Worker。按照下面的原始委托、目标和验收条件完成工作。需要用户补充时调用 task_ask。完成时用 task_report(ready) 提交可直接阅读的结果摘要、实际验证证据及可选文件路径；无法完成用 failed。不要把未验证的内容写成成功。";
		return {
			systemPrompt: `${event.systemPrompt}\n\n${instruction}\n任务上下文（来自任务服务）：\n${JSON.stringify(context)}\n调用 task_ask/task_decide/task_report 成功后立即结束本轮，不继续调用工具。此任务不允许派生 agent、后台 job 或外发。`,
		};
	});
	pi.on("tool_call", async (event, ctx) => {
		if (terminal || !allowed.includes(event.toolName))
			return { block: true, reason: "本轮已交付，或工具不在任务授权内" };
		try {
			let input = event.input;
			if (["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName)) {
				const path = "path" in input && typeof input.path === "string" ? input.path : ".";
				// Authorize the same path the built-in tool will resolve (including ~, @ and macOS variants).
				input = {
					...input,
					path:
						event.toolName === "read" ? await resolveReadPathAsync(path, ctx.cwd) : resolveToCwd(path, ctx.cwd),
				};
			}
			await client.request("gate", { tool: event.toolName, input }, ctx.signal);
		} catch (error) {
			return { block: true, reason: `任务授权检查失败：${String(error)}` };
		}
		return undefined;
	});
	pi.registerTool({
		name: "task_context",
		label: "任务上下文",
		description: "Read the current authorized task and recent user answers.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) {
			return result(await client.request("context", { sessionFile: ctx.sessionManager.getSessionFile() }, signal));
		},
	});
	pi.registerTool({
		name: "task_ask",
		label: "登记任务问题",
		description:
			"Persist one question for the user, then end this turn. The answer will resume this task later; do not wait or poll.",
		parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
		executionMode: "sequential",
		async execute(callId, params, signal) {
			const reply = await client.request("ask", { callId, ...params }, signal);
			terminal = true;
			pi.setActiveTools([]);
			return result(reply);
		},
	});
	if (role === "router")
		pi.registerTool({
			name: "task_decide",
			label: "提交接单判断",
			description:
				"Submit create with a faithful goal and verifiable acceptance criteria, or ignore with a reason. End this turn after recording.",
			parameters: Type.Object({
				decision: Type.Union([Type.Literal("create"), Type.Literal("ignore")]),
				reason: Type.String(),
				title: Type.Optional(Type.String()),
				goal: Type.Optional(Type.String()),
				acceptance: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			async execute(callId, params, signal) {
				const reply = await client.request("decide", { callId, ...params }, signal);
				terminal = true;
				pi.setActiveTools([]);
				return result(reply);
			},
		});
	else
		pi.registerTool({
			name: "task_report",
			label: "交付任务结果",
			description:
				"Report ready with the actual result and validation evidence, or failed with a recovery hint. Artifact paths must exist inside the authorized working directory. End this turn afterwards.",
			parameters: Type.Object({
				state: Type.Union([Type.Literal("ready"), Type.Literal("failed")]),
				summary: Type.String(),
				artifacts: Type.Optional(Type.Array(Type.String())),
			}),
			executionMode: "sequential",
			async execute(callId, params, signal) {
				const reply = await client.request("report", { callId, ...params }, signal);
				terminal = true;
				pi.setActiveTools([]);
				return result(reply);
			},
		});
}
