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
import { resolveMemberRole } from "../expert-context/package.ts";
import { type BackgroundTaskRecord, backgroundTasks } from "./background.ts";
import { type ChildHandle, childSessionDir, findChildSessionFile, lookup, nextChildId } from "./children.ts";
import { acquireChild, childSlots } from "./concurrency.ts";
import { registerBackgroundNotifications } from "./notifications.ts";
import { createChild, formatOutcome, reviveChild, runTurn, type SubagentDetails } from "./runner.ts";
import { DEFAULT_TOOLS, normalizeTools, restoreChildTools, validateChildId } from "./tools.ts";

interface AgentParams {
	prompt: string;
	subagent_type?: string;
	name?: string;
	description?: string;
	tools?: string[] | string;
	resume?: string;
	run_in_background?: boolean;
}

interface PendingRun {
	runId?: string;
	tools: string[];
	signal?: AbortSignal;
	cancelled: boolean;
	executing: boolean;
	phase: "queued" | "initializing" | "running";
	handle?: ChildHandle;
	prompts: string[];
}
// One owner from registration through settlement, including before a session exists.
const running = new Map<string, PendingRun>();

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
		promptSnippet:
			"agent(prompt, subagent_type?, description?, tools?, resume?, run_in_background?) — 派生/续写子 agent；专家团可按成员 ID 绑定角色",
		promptGuidelines: ["子 agent 报错或卡死后用 agent(resume=它的 id) 继续；后台任务通过 agent_tasks 查询或取消"],
		parameters: Type.Object({
			prompt: Type.String({ description: "完整任务描述；resume 时为追加的新指令。" }),
			subagent_type: Type.Optional(Type.String({ description: "专家团成员 ID；加载其独立角色定义，新建时使用。" })),
			name: Type.Optional(Type.String({ description: "WorkBuddy 成员 ID 兼容别名；优先使用 subagent_type。" })),
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
	// Identity is immutable on resume. Never reinterpret a member id as a child id.
	if (resumeId && (params.subagent_type || params.name)) {
		throw new Error("resume 沿用原成员身份，请省略 subagent_type/name，仅传返回的 childId");
	}
	const roleId = params.subagent_type?.trim() || params.name?.trim();
	const role = roleId ? resolveMemberRole(cwd, roleId, process.env.KALO_EXPERT_DIR?.trim() || cwd) : undefined;
	const childId = resumeId || nextChildId();
	validateChildId(childId);
	// Match registry identity, including legacy ids and cwd spelling changes on Windows.
	const key = JSON.stringify([owner, childId]);
	const active = running.get(key);
	if (active) {
		if (active.cancelled || active.signal?.aborted) {
			throw new Error(
				`子 agent ${childId} 正在取消，未接受追加指令；runId：${active.runId ?? "前台运行"}。请等待结束后再 resume。`,
			);
		}
		if (active.phase === "running" && active.handle && !active.handle.session.isIdle) {
			await active.handle.session.followUp(params.prompt);
		} else {
			active.prompts.push(params.prompt);
		}
		return {
			content: [
				{
					type: "text",
					text:
						`子 agent ${childId} 的追加指令已排队到当前运行，未创建新运行。` +
						`工具权限：${active.tools.join(", ") || "无"}。${active.runId ? `runId：${active.runId}，用 agent_tasks 查看结果。` : "结果由原前台调用返回。"}`,
				},
			],
			details: {
				childId,
				runId: active.runId,
				background: Boolean(active.runId),
				resumed: true,
				queued: true,
				tools: [...active.tools],
				turns: 0,
				tokens: 0,
				truncated: false,
			},
		};
	}
	const resident = resumeId ? lookup(resumeId, owner) : undefined;
	const sessionPath = resumeId && !resident ? findChildSessionFile(cwd, owner, resumeId, agentDir) : undefined;
	if (resumeId && !resident && !sessionPath) {
		const prior = backgroundTasks
			.list(directory, owner)
			.filter((record) => record.childId === childId)
			.at(-1);
		if (prior)
			throw new Error(
				`子 agent ${childId} 无可恢复的会话历史（${prior.status}，runId：${prior.runId}）。请用 agent_tasks 查看原运行；需要重新执行时新建 child 并显式指定工具。`,
			);
		throw new Error(`未知子 agent：${resumeId}`);
	}
	const tools = resident
		? [...resident.tools]
		: resumeId
			? restoreChildTools(
					directory,
					childId,
					sessionPath ? SessionManager.open(sessionPath, directory, cwd).getEntries() : [],
				)
			: normalizeTools(params.tools);
	const entry: PendingRun = {
		tools: [...tools],
		cancelled: false,
		executing: false,
		phase: "queued",
		prompts: [params.prompt],
	};
	running.set(key, entry);
	let unsubscribe: (() => void) | undefined;
	const cleanup = () => {
		if (running.get(key) === entry) running.delete(key);
		entry.prompts.length = 0;
		unsubscribe?.();
	};
	const run = async (runSignal?: AbortSignal) => {
		entry.executing = true;
		entry.signal = runSignal;
		let unlock: (() => void) | undefined;
		try {
			unlock = await acquireChild(key, runSignal);
			const release = await childSlots.acquire(runSignal);
			try {
				runSignal?.throwIfAborted();
				entry.phase = "initializing";
				const options = {
					cwd,
					model,
					thinkingLevel,
					tools,
					parentSessionId: owner,
					childId,
					role,
					description: params.description,
				};
				// Recheck after the lock: another queued resume may have revived the child already.
				const handle = resumeId
					? (lookup(childId, owner) ?? (await reviveChild(options)))
					: await createChild(options);
				entry.handle = handle;
				entry.tools = [...handle.tools];
				entry.phase = "running";
				let resumed = Boolean(resumeId);
				while (true) {
					// Preserve the original prompt and every pre-start addition, in receipt order.
					const prompt = entry.prompts.splice(0).join("\n\n--- 追加指令（按接收顺序）---\n\n");
					const outcome = await runTurn({
						handle,
						parentSessionId: owner,
						prompt,
						signal: runSignal,
						resumed,
						description: params.description,
						onUpdate: params.run_in_background ? undefined : onUpdate,
					});
					if (outcome.failed || outcome.aborted || outcome.stalled || !entry.prompts.length) return outcome;
					resumed = true;
				}
			} finally {
				release();
			}
		} finally {
			unlock?.();
			cleanup();
		}
	};
	if (params.run_in_background) {
		// start may be cancelled before its executor is ever called. Observe that terminal path too.
		unsubscribe = backgroundTasks.subscribe((event) => {
			if (event.type !== "change" || event.record.owner !== owner || event.record.childId !== childId) return;
			if (entry.runId && entry.runId !== event.record.runId) return;
			entry.runId = event.record.runId;
			if (event.record.cancelRequestedAt !== undefined) entry.cancelled = true;
			if (event.record.finishedAt !== undefined && !entry.executing) cleanup();
		});
		let record: BackgroundTaskRecord;
		try {
			record = backgroundTasks.start({
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
		} catch (error) {
			cleanup();
			throw error;
		}
		const runId = record.runId;
		entry.runId = runId;
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
