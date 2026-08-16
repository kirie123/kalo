/**
 * Subagent extension — kalo's single-shot task delegation tool.
 *
 * Design: doc/kalo-subagent-design.md. One `agent` tool call spawns an
 * independent AgentSession in-process (in-memory history, trimmed toolset,
 * no nested extensions) and returns its final answer to the parent run.
 * Parallelism comes from the model issuing several `agent` tool calls in one
 * assistant turn; a process-wide semaphore caps concurrent children.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

/** Read-only exploration tools a child may use unless the call opts out. */
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
/** Hard ceiling on the child's final text handed back to the parent model. */
const MAX_RESULT_CHARS = 16_000;
/** Watchdog so a wedged child cannot pin a parent tool call forever. */
const HARD_TIMEOUT_MS = 10 * 60_000;
/** Max concurrent child agents per engine process (local models queue anyway). */
const MAX_CONCURRENCY = 3;

interface SubagentDetails {
	description?: string;
	turns: number;
	tokens: number;
	truncated: boolean;
	timedOut?: boolean;
	aborted?: boolean;
}

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

let activeChildren = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<() => void> {
	if (activeChildren >= MAX_CONCURRENCY) {
		await new Promise<void>((resolve) => waiters.push(resolve));
	}
	activeChildren++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeChildren--;
		waiters.shift()?.();
	};
}

// ---------------------------------------------------------------------------
// Child run
// ---------------------------------------------------------------------------

interface ChildOutcome {
	text: string;
	turns: number;
	tokens: number;
	truncated: boolean;
	timedOut: boolean;
	aborted: boolean;
}

async function runChild(opts: {
	cwd: string;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	prompt: string;
	tools: string[];
	signal: AbortSignal | undefined;
}): Promise<ChildOutcome> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(opts.cwd, agentDir);
	// noExtensions keeps the child clean: no subagent (no recursion), no MCP,
	// no memory — just the trimmed builtin toolset below.
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		tools: opts.tools,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader: loader,
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, HARD_TIMEOUT_MS);
	const onAbort = () => void session.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.prompt(opts.prompt);
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}

	const messages = session.agent.state.messages;
	let turns = 0;
	let tokens = 0;
	for (const m of messages) {
		if (m.role === "assistant") {
			turns++;
			tokens += m.usage?.input ?? 0;
			tokens += m.usage?.output ?? 0;
		}
	}
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	const raw = last ? assistantText(last) : "(子 agent 未产生回复)";
	const truncated = raw.length > MAX_RESULT_CHARS;
	const text = truncated
		? `${raw.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${raw.length - MAX_RESULT_CHARS} chars]`
		: raw;

	return {
		text,
		turns,
		tokens,
		truncated,
		timedOut,
		aborted: opts.signal?.aborted ?? false,
	};
}

/** Concatenate the text blocks of an assistant message. */
function assistantText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agent",
		label: "子 Agent",
		description:
			"派生一个独立的子 agent 执行一项自包含的任务，并把它的最终答复带回来。" +
			"子 agent 看不到当前对话，prompt 必须完整自包含（含目标、路径、输出要求）。" +
			"适合独立的调研、多文件探索、批量验证等可以并行的工作：在一条消息里发起多个 agent 调用即可并行执行。" +
			"默认只读工具集（read/grep/find/ls），结果文本超长会截断。",
		promptSnippet: "agent(prompt, description?, tools?) — 派生子 agent 执行独立任务并回传结果；可并行",
		parameters: Type.Object({
			prompt: Type.String({
				description: "完整自包含的任务描述：目标、相关路径、期望的输出格式。子 agent 看不到本次对话的任何内容。",
			}),
			description: Type.Optional(Type.String({ description: "3-5 个词的任务摘要，用于展示。" })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: `子 agent 可用的工具名列表，默认 ${DEFAULT_TOOLS.join("/")}（只读）。`,
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { prompt: string; description?: string; tools?: string[] },
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SubagentDetails>> {
			const tools = params.tools?.length ? params.tools : DEFAULT_TOOLS;
			const release = await acquireSlot();
			try {
				const outcome = await runChild({
					cwd: ctx.cwd,
					model: ctx.model,
					thinkingLevel: ctx.thinkingLevel,
					prompt: params.prompt,
					tools,
					signal,
				});
				const details: SubagentDetails = {
					description: params.description,
					turns: outcome.turns,
					tokens: outcome.tokens,
					truncated: outcome.truncated,
					timedOut: outcome.timedOut,
				};
				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: `子 agent 已中止（已运行 ${outcome.turns} 轮）。部分结果：\n${outcome.text}`,
							},
						],
						details: { ...details, aborted: true },
					};
				}
				if (outcome.timedOut) {
					throw new Error(`子 agent 超时（${HARD_TIMEOUT_MS / 60000} 分钟）被中止。部分结果：\n${outcome.text}`);
				}
				return {
					content: [
						{
							type: "text",
							text: params.description ? `【${params.description}】\n${outcome.text}` : outcome.text,
						},
					],
					details,
				};
			} catch (err) {
				throw new Error(`子 agent 执行失败：${err instanceof Error ? err.message : String(err)}`);
			} finally {
				release();
			}
		},
	});
}
