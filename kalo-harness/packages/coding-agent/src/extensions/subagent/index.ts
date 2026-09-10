/**
 * Subagent extension — kalo's single-shot task delegation tool.
 *
 * Design: doc/kalo-subagent-design.md. One `agent` tool call spawns an
 * independent AgentSession in-process (in-memory history, trimmed toolset,
 * only the webfetch extension) and returns its final answer to the parent run.
 * Parallelism comes from the model issuing several `agent` tool calls in one
 * assistant turn; a process-wide semaphore caps concurrent children.
 *
 * Liveness and transcripts: doc/2026-09-10-子agent-idle-watchdog与转录落盘.md
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
import { renderTranscript, writeTranscript } from "./transcript.ts";

/**
 * Read-only exploration tools a child may use unless the call opts out.
 * `web_fetch` comes from the one extension children load (see getChildResources)
 * and is in the default set because research tasks are the common delegation.
 */
const DEFAULT_TOOLS = ["read", "grep", "glob", "ls", "web_fetch"];
/** Hard ceiling on the child's final text handed back to the parent model. */
const MAX_RESULT_CHARS = 16_000;
/**
 * Liveness watchdog: abort only after this long with NO child activity at all.
 *
 * This is deliberately not a total-duration cap. A healthy research task that
 * fetches thirty pages legitimately runs for twenty minutes while emitting a
 * steady stream of message/tool events; killing it on wall-clock time throws
 * away all of that work. What actually needs guarding against is a wedged child
 * (provider hung, tool never returning) pinning the parent's tool call forever,
 * and silence is the signal for that. Every child event resets the timer.
 */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/**
 * Max concurrent child agents per engine process.
 *
 * Cloud models answer several children at once, so a low cap wastes the main
 * win of delegation: six parallel research children finish in roughly the time
 * one does. The cap still exists because each child holds a provider
 * connection and its own tool traffic — unbounded fan-out invites 429s and
 * runaway token spend. Local models serialize on the GPU anyway, so a higher
 * cap only changes queue depth for them.
 *
 * Override with KALO_SUBAGENT_CONCURRENCY (integer >= 1) when a deployment
 * needs a different ceiling without rebuilding the engine.
 */
const DEFAULT_MAX_CONCURRENCY = 6;

function resolveMaxConcurrency(): number {
	const raw = process.env.KALO_SUBAGENT_CONCURRENCY?.trim();
	if (!raw) return DEFAULT_MAX_CONCURRENCY;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENCY;
	return parsed;
}

const MAX_CONCURRENCY = resolveMaxConcurrency();
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
	/** Set when the liveness watchdog aborted a silent child. */
	stalled?: boolean;
	aborted?: boolean;
	/** Markdown transcript of the child's run, when one was written. */
	transcriptPath?: string;
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
	stalled: boolean;
	aborted: boolean;
	activity: ChildActivity[];
	transcriptPath: string | undefined;
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
		// Any event at all counts as liveness, including the stream deltas and
		// tool progress updates not handled below.
		resetIdleTimer();
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

	let stalled = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	function resetIdleTimer(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			stalled = true;
			void session.abort();
		}, IDLE_TIMEOUT_MS);
	}
	resetIdleTimer();
	const onAbort = () => void session.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.prompt(opts.prompt);
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
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
	const aborted = opts.signal?.aborted ?? false;

	// Written for every ending, not just the bad ones: the parent may also want
	// the full process behind a truncated but successful answer.
	const transcriptPath = writeTranscript(
		agentDir,
		renderTranscript(messages, {
			prompt: opts.prompt,
			description: opts.description,
			tools: opts.tools,
			outcome: stalled ? `静默超过 ${IDLE_TIMEOUT_MS / 60_000} 分钟被中止` : aborted ? "被用户中止" : "正常结束",
		}),
	);

	return {
		text,
		turns,
		tokens,
		truncated,
		stalled,
		aborted,
		activity,
		transcriptPath,
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
			"默认工具集为只读探索 + 联网抓取（read/grep/glob/ls/web_fetch），结果文本超长会截断；" +
			"截断或中途停下时，返回文本里会附上完整过程转录的文件路径，可用 read/grep 自行查看。",
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
					stalled: outcome.stalled,
					activity: outcome.activity,
					transcriptPath: outcome.transcriptPath,
				};
				// A cut-short or truncated child still did real work. Returning an
				// error here makes the parent model discard all of it and retry from
				// scratch, so hand back the partial answer plus a pointer to the full
				// transcript and let the parent decide what to do.
				const pointer = outcome.transcriptPath
					? `\n\n（完整过程转录：${outcome.transcriptPath}，可用 read/grep 自行查看）`
					: "";
				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: `子 agent 已中止（已运行 ${outcome.turns} 轮）。部分结果：\n${outcome.text}${pointer}`,
							},
						],
						details: { ...details, aborted: true },
					};
				}
				if (outcome.stalled) {
					return {
						content: [
							{
								type: "text",
								text:
									`子 agent 连续 ${IDLE_TIMEOUT_MS / 60_000} 分钟无任何动静，已按卡死处理中止（已运行 ${outcome.turns} 轮）。` +
									`中止前的最后一段输出：\n${outcome.text}${pointer}`,
							},
						],
						details,
					};
				}
				const head = params.description ? `【${params.description}】\n` : "";
				return {
					content: [{ type: "text", text: `${head}${outcome.text}${outcome.truncated ? pointer : ""}` }],
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
