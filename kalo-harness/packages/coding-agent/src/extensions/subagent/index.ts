/** Agent tool wiring. Background ownership and delivery live in background.ts / notifications.ts. */
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { backgroundTasks } from "./background.ts";
import { type ChildHandle, childSessionDir, findChildSessionFile, lookup, nextChildId } from "./children.ts";
import { acquireChild, childSlots } from "./concurrency.ts";
import { registerBackgroundNotifications } from "./notifications.ts";
import { createChild, formatOutcome, reviveChild, runTurn, type SubagentDetails } from "./runner.ts";
import { DEFAULT_TOOLS, normalizeTools, restoreChildTools, validateChildId } from "./tools.ts";

interface AgentParams {
	prompt: string;
	description?: string;
	tools?: string[] | string;
	resume?: string;
	run_in_background?: boolean;
}

// Only the owner of this entry subscribes, records a transcript and releases slots.
const running = new Map<string, { handle: ChildHandle; runId?: string; signal?: AbortSignal }>();

export default function subagentExtension(pi: ExtensionAPI): void {
	registerBackgroundNotifications(pi);
	pi.registerTool({
		name: "agent",
		label: "子 Agent",
		description:
			"派生独立子 agent 执行自包含任务。子 agent 看不到当前对话，prompt 必须包含目标、路径、输出要求。" +
			"默认前台等待最终答复；run_in_background=true 持久登记后立即返回 childId/runId，主轮结束不取消后台任务，" +
			"用 agent_tasks 查看结果或取消。应用退出会中断任务。" +
			"resume=子 agent id 保留上下文续写；运行中仅追加 follow-up 并返回已排队，结果归当前运行。" +
			"默认工具 read/grep/glob/ls/web_fetch；resume 沿用初始权限，旧会话无权限记录时无工具。" +
			"长结果截断，返回转录路径可用 read/grep 查看。",
		promptSnippet: "agent(prompt, description?, tools?, resume?, run_in_background?) — 派生/续写子 agent，可后台执行",
		promptGuidelines: ["子 agent 报错或卡死后用 agent(resume=它的 id) 继续；后台任务通过 agent_tasks 查询或取消"],
		parameters: Type.Object({
			prompt: Type.String({ description: "完整任务描述；resume 时为追加的新指令。" }),
			description: Type.Optional(Type.String({ description: "3-5 个词的任务摘要。" })),
			tools: Type.Optional(
				Type.Union([Type.Array(Type.String()), Type.String()], {
					description:
						`工具名称数组或逗号/空白分隔字符串；默认 ${DEFAULT_TOOLS.join("/")}。` +
						"可选 read/grep/glob/find/ls/bash/edit/write/web_fetch；空列表禁用工具，resume 忽略此参数。",
				}),
			),
			resume: Type.Optional(Type.String({ description: "之前返回的子 agent id，含旧 subagent-N。" })),
			run_in_background: Type.Optional(
				Type.Boolean({ description: "持久登记后立即返回，独立于主轮取消信号运行。" }),
			),
		}),
		execute: executeAgent,
	});
}

export async function executeAgent(
	_toolCallId: string,
	params: AgentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
	signal?.throwIfAborted();
	// Capture values, never retain a parent extension context inside a background executor.
	const cwd = ctx.cwd;
	const owner = ctx.sessionManager.getSessionId();
	const model = ctx.model;
	const thinkingLevel = ctx.thinkingLevel;
	const agentDir = getAgentDir();
	const directory = childSessionDir(cwd, owner, agentDir);
	const resumeId = params.resume?.trim();
	const childId = resumeId || nextChildId();
	validateChildId(childId);
	// Match registry identity, including legacy ids and cwd spelling changes on Windows.
	const key = JSON.stringify([owner, childId]);
	const resident = resumeId ? lookup(resumeId, owner) : undefined;
	const sessionPath = resumeId && !resident ? findChildSessionFile(cwd, owner, resumeId, agentDir) : undefined;
	if (resumeId && !resident && !sessionPath) throw new Error(`未知子 agent：${resumeId}`);
	const tools = resident
		? [...resident.tools]
		: resumeId
			? restoreChildTools(
					directory,
					childId,
					sessionPath ? SessionManager.open(sessionPath, directory, cwd).getEntries() : [],
				)
			: normalizeTools(params.tools);
	const active = running.get(key);
	if (active && !active.signal?.aborted && !active.handle.session.isIdle) {
		await active.handle.session.followUp(params.prompt);
		return {
			content: [
				{
					type: "text",
					text:
						`子 agent ${childId} 的追加指令已排队到当前运行，未创建新运行。` +
						`实际工具：${active.handle.tools.join(", ") || "无"}。${active.runId ? `runId：${active.runId}，用 agent_tasks 查看结果。` : "结果由原前台调用返回。"}`,
				},
			],
			details: {
				childId,
				runId: active.runId,
				background: Boolean(active.runId),
				resumed: true,
				queued: true,
				tools: [...active.handle.tools],
				turns: 0,
				tokens: 0,
				truncated: false,
			},
		};
	}

	let runId: string | undefined;
	const run = async (runSignal?: AbortSignal) => {
		const unlock = await acquireChild(key, runSignal);
		try {
			const release = await childSlots.acquire(runSignal);
			try {
				runSignal?.throwIfAborted();
				const options = {
					cwd,
					model,
					thinkingLevel,
					tools,
					parentSessionId: owner,
					childId,
					description: params.description,
				};
				// Recheck after the lock: another queued resume may have revived the child already.
				const handle = resumeId
					? (lookup(childId, owner) ?? (await reviveChild(options)))
					: await createChild(options);
				running.set(key, { handle, runId, signal: runSignal });
				try {
					return await runTurn({
						handle,
						parentSessionId: owner,
						prompt: params.prompt,
						signal: runSignal,
						resumed: Boolean(resumeId),
						description: params.description,
						onUpdate: params.run_in_background ? undefined : onUpdate,
					});
				} finally {
					running.delete(key);
				}
			} finally {
				release();
			}
		} finally {
			unlock();
		}
	};
	if (params.run_in_background) {
		const record = backgroundTasks.start({
			directory,
			owner,
			childId,
			description: params.description,
			run: async (backgroundSignal) => {
				const outcome = await run(backgroundSignal);
				const formatted = formatOutcome(outcome, params.description);
				return {
					text: formatted.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("\n"),
					failed: outcome.failed,
					aborted: outcome.aborted,
					stalled: outcome.stalled,
					transcriptPath: outcome.transcriptPath,
				};
			},
		});
		runId = record.runId;
		return {
			content: [
				{
					type: "text",
					text:
						`后台子 agent 已登记，等待执行。childId：${childId}；runId：${runId}。` +
						`工具权限：${tools.join(", ") || "无"}（执行时校验实际工具）。用 agent_tasks 查看结果或取消。`,
				},
			],
			details: {
				childId,
				runId,
				background: true,
				queued: true,
				resumed: Boolean(resumeId),
				tools,
				description: params.description,
				turns: 0,
				tokens: 0,
				truncated: false,
			},
		};
	}
	return formatOutcome(await run(signal), params.description);
}
