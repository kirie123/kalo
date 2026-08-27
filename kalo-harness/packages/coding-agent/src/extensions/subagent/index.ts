/**
 * Subagent extension — kalo's single-shot task delegation tool.
 *
 * Design: doc/kalo-subagent-design.md. One `agent` tool call spawns an
 * independent AgentSession in-process (in-memory history, trimmed toolset,
 * only the webfetch extension) and returns its final answer to the parent run.
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
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
// Imported directly rather than via ../index.ts: that module also pulls in this
// one, and going through it would be a circular import.
import webFetchExtension from "../webfetch/index.ts";

/**
 * Read-only exploration tools a child may use unless the call opts out.
 * `web_fetch` comes from the one extension children load (see getChildResources)
 * and is in the default set because research tasks are the common delegation.
 */
const DEFAULT_TOOLS = ["read", "grep", "glob", "ls", "web_fetch"];
/** Hard ceiling on the child's final text handed back to the parent model. */
const MAX_RESULT_CHARS = 16_000;
/** Watchdog so a wedged child cannot pin a parent tool call forever. */
const HARD_TIMEOUT_MS = 10 * 60_000;
/** Max concurrent child agents per engine process (local models queue anyway). */
const MAX_CONCURRENCY = 3;
/** Per-entry and total caps for the live activity feed pushed to the UI. */
const MAX_ACTIVITY_TEXT_CHARS = 2_000;
const MAX_ACTIVITY_ITEMS = 200;

/** One entry in the child's live activity feed (assistant texts and tool calls). */
type ChildActivity =
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			toolCallId: string;
			name: string;
			label: string;
			status: "running" | "success" | "error";
	  };

interface SubagentDetails {
	description?: string;
	turns: number;
	tokens: number;
	truncated: boolean;
	/** Live step counter pushed via onUpdate while the child is running. */
	steps?: number;
	/** Live activity feed: child assistant texts and tool calls, newest last. */
	activity?: ChildActivity[];
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
// Shared child resources
// ---------------------------------------------------------------------------

/**
 * Heavyweight read-only resources shared by every child session in this
 * process, cached per cwd. Rebuilding SettingsManager + ResourceLoader +
 * ModelRuntime on each `agent` call means re-reading settings files and
 * re-scanning extensions/skills/prompts — all unnecessary for children that
 * run with `noExtensions: true` anyway.
 */
interface ChildResources {
	settingsManager: SettingsManager;
	loader: DefaultResourceLoader;
	modelRuntime: ModelRuntime;
}

const childResourceCache = new Map<string, Promise<ChildResources>>();

function getChildResources(cwd: string, agentDir: string): Promise<ChildResources> {
	let entry = childResourceCache.get(cwd);
	if (!entry) {
		entry = (async () => {
			const settingsManager = SettingsManager.create(cwd, agentDir);
			// noExtensions skips every disk-discovered extension, keeping the child
			// clean: no subagent (no recursion), no MCP, no memory. Inline factories
			// are loaded regardless of that flag, so webfetch is injected explicitly
			// — without it `web_fetch` is unregistered and children cannot go online.
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				extensionFactories: [{ name: "webfetch", factory: webFetchExtension, hidden: true }],
			});
			await loader.reload();
			const modelRuntime = await ModelRuntime.create({});
			return { settingsManager, loader, modelRuntime };
		})();
		childResourceCache.set(cwd, entry);
	}
	return entry;
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
	activity: ChildActivity[];
}

/** Short human label for a child tool call row, e.g. the path or pattern. */
function childToolLabel(name: string, args: any): string {
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return String(args?.path ?? "");
		case "grep":
			return String(args?.pattern ?? args?.query ?? "");
		case "glob":
			return String(args?.pattern ?? "");
		case "bash":
			return String(args?.command ?? "");
		case "web_fetch":
			return String(args?.url ?? "");
		default:
			return name;
	}
}

async function runChild(opts: {
	cwd: string;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	prompt: string;
	tools: string[];
	signal: AbortSignal | undefined;
	/** Task summary echoed back in every progress update. */
	description?: string;
	/** Progress sink: called on each child step, tool call and assistant text. */
	onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
}): Promise<ChildOutcome> {
	const agentDir = getAgentDir();
	const { settingsManager, loader, modelRuntime } = await getChildResources(opts.cwd, agentDir);

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		tools: opts.tools,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader: loader,
		modelRuntime,
	});

	// Track the child's activity (steps, tokens, texts, tool calls) and push
	// it to the parent's UI as partial tool results.
	const activity: ChildActivity[] = [];
	let steps = 0;
	let liveTokens = 0;
	const emit = () => {
		opts.onUpdate?.({
			content: [],
			details: {
				description: opts.description,
				turns: steps,
				tokens: liveTokens,
				truncated: false,
				steps,
				activity: activity.map((a) => ({ ...a })),
			},
		});
	};
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			steps++;
			emit();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
			liveTokens += (usage?.input ?? 0) + (usage?.output ?? 0);
			const text = assistantText(event.message).trim();
			if (text) {
				activity.push({
					kind: "text",
					text: text.length > MAX_ACTIVITY_TEXT_CHARS ? `${text.slice(0, MAX_ACTIVITY_TEXT_CHARS)}…` : text,
				});
			}
			emit();
		} else if (event.type === "tool_execution_start") {
			activity.push({
				kind: "tool",
				toolCallId: event.toolCallId,
				name: event.toolName,
				label: childToolLabel(event.toolName, event.args),
				status: "running",
			});
			if (activity.length > MAX_ACTIVITY_ITEMS) {
				activity.splice(0, activity.length - MAX_ACTIVITY_ITEMS);
			}
			emit();
		} else if (event.type === "tool_execution_end") {
			for (let i = activity.length - 1; i >= 0; i--) {
				const entry = activity[i];
				if (entry.kind === "tool" && entry.toolCallId === event.toolCallId) {
					entry.status = event.isError ? "error" : "success";
					break;
				}
			}
			emit();
		}
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
		unsubscribe();
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
		activity,
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
			"默认工具集为只读探索 + 联网抓取（read/grep/glob/ls/web_fetch），结果文本超长会截断。",
		promptSnippet: "agent(prompt, description?, tools?) — 派生子 agent 执行独立任务并回传结果；可并行",
		parameters: Type.Object({
			prompt: Type.String({
				description: "完整自包含的任务描述：目标、相关路径、期望的输出格式。子 agent 看不到本次对话的任何内容。",
			}),
			description: Type.Optional(Type.String({ description: "3-5 个词的任务摘要，用于展示。" })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						`子 agent 可用的工具名列表，默认 ${DEFAULT_TOOLS.join("/")}。` +
						"可选值：read/grep/glob/find/ls/bash/edit/write/web_fetch。",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { prompt: string; description?: string; tools?: string[] },
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
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
					description: params.description,
					onUpdate,
				});
				const details: SubagentDetails = {
					description: params.description,
					turns: outcome.turns,
					tokens: outcome.tokens,
					truncated: outcome.truncated,
					timedOut: outcome.timedOut,
					activity: outcome.activity,
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
