/**
 * Subagent extension — kalo's task delegation tool.
 *
 * Design: doc/kalo-subagent-design.md and
 * doc/2026-09-11-可续写子agent与主agent派生.md. One `agent` tool call spawns an
 * independent AgentSession in-process (trimmed toolset, only the webfetch
 * extension) and returns its final answer to the parent run. Parallelism comes
 * from the model issuing several `agent` tool calls in one assistant turn; a
 * process-wide semaphore caps concurrent children.
 *
 * A child stays resident after its turn ends and can be handed another message
 * with `resume`, which is what makes an interrupted child recoverable instead
 * of a total loss. History is a real session file, so resume also survives
 * eviction and engine restarts.
 *
 * Liveness and transcripts: doc/2026-09-10-子agent-idle-watchdog与转录落盘.md
 */

import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { AgentToolResult, AgentToolUpdateCallback } from "../../core/extensions/types.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
// Imported directly rather than via ../index.ts: that module also pulls in this
// one, and going through it would be a circular import.
import webFetchExtension from "../webfetch/index.ts";
import { applyCompactionActivity, type ChildActivity, MAX_ACTIVITY_TEXT_CHARS, trimActivity } from "./activity.ts";
import { type ChildHandle, childSessionDir, childTranscriptPath, findChildSessionFile, register } from "./children.ts";
import { FailureGuard } from "./failure-guard.ts";
import { CHILD_TOOLS_ENTRY, persistChildTools, restoreChildTools } from "./tools.ts";
import { appendTranscript, renderTranscript } from "./transcript.ts";

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
export interface SubagentDetails {
	runId?: string;
	background?: boolean;
	queued?: boolean;
	tools?: string[];
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
	/** Error message when the child's turn threw; it stays resumable. */
	failed?: string;
	/** Markdown transcript of the child's run, when one was written. */
	transcriptPath?: string;
	/** Child id the parent passes back to `resume`. */
	childId?: string;
	/** True when this call continued an existing child instead of creating one. */
	resumed?: boolean;
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

export interface ChildOutcome {
	text: string;
	tools: string[];
	turns: number;
	tokens: number;
	truncated: boolean;
	stalled: boolean;
	aborted: boolean;
	/**
	 * Error message when the turn threw, else undefined.
	 *
	 * The parent has to be told why a child stopped: a provider outage and a
	 * bad prompt both end the turn, but only one is worth resuming as-is.
	 */
	failed: string | undefined;
	activity: ChildActivity[];
	transcriptPath: string | undefined;
	childId: string;
	resumed: boolean;
}

/** Short human label for a child tool call row, e.g. the path or pattern. */
function childToolLabel(name: string, input: unknown): string {
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
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

/**
 * Create a new child session backed by a file under the parent's cwd bucket.
 *
 * The session file is what makes `resume` work after eviction or an engine
 * restart; `parentSession` records the link for anyone reading the file later.
 */
export async function createChild(opts: {
	cwd: string;
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	tools: string[];
	parentSessionId: string;
	childId: string;
	description?: string;
}): Promise<ChildHandle> {
	const agentDir = getAgentDir();
	const { settingsManager, loader, modelRuntime } = await getChildResources(opts.cwd, agentDir);
	// SessionManager picks the file name itself (`<timestamp>_<id>.jsonl`); we
	// only choose the directory. findChildSessionFile recognises it later.
	const sessionDir = childSessionDir(opts.cwd, opts.parentSessionId, agentDir);

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		tools: opts.tools,
		sessionManager: SessionManager.create(opts.cwd, sessionDir, {
			id: opts.childId,
			parentSession: opts.parentSessionId,
		}),
		settingsManager,
		resourceLoader: loader,
		modelRuntime,
	});

	const tools = session.getActiveToolNames();
	try {
		if (opts.tools.some((name) => !tools.includes(name)) || tools.some((name) => !opts.tools.includes(name))) {
			throw new Error("子 agent 实际工具与请求权限不一致");
		}
		persistChildTools(sessionDir, opts.childId, tools);
		session.sessionManager.appendCustomEntry(CHILD_TOOLS_ENTRY, { tools });
	} catch (error) {
		session.dispose();
		throw error;
	}
	const now = Date.now();
	const handle: ChildHandle = {
		id: opts.childId,
		session,
		status: "running",
		cwd: opts.cwd,
		ownerSession: opts.parentSessionId,
		description: opts.description,
		tools,
		turns: 0,
		createdAt: now,
		lastActiveAt: now,
	};
	register(handle);
	return handle;
}

/**
 * Rebuild a child whose handle is gone but whose session file remains (evicted,
 * or left by a previous engine process).
 */
export async function reviveChild(opts: {
	cwd: string;
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	tools: string[];
	parentSessionId: string;
	childId: string;
	description?: string;
}): Promise<ChildHandle> {
	const agentDir = getAgentDir();
	const { settingsManager, loader, modelRuntime } = await getChildResources(opts.cwd, agentDir);
	const sessionPath = findChildSessionFile(opts.cwd, opts.parentSessionId, opts.childId, agentDir);
	if (!sessionPath) throw new Error(`子 agent 会话文件已消失：${opts.childId}`);

	const manager = SessionManager.open(sessionPath, dirname(sessionPath), opts.cwd);
	const tools = restoreChildTools(dirname(sessionPath), opts.childId, manager.getEntries());
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		tools,
		sessionManager: manager,
		settingsManager,
		resourceLoader: loader,
		modelRuntime,
	});

	const activeTools = session.getActiveToolNames();
	if (activeTools.some((name) => !tools.includes(name))) {
		session.dispose();
		throw new Error("恢复的子 agent 工具超出持久权限");
	}
	let priorTurns = 0;
	for (const m of session.agent.state.messages) {
		if (m.role === "assistant") priorTurns++;
	}
	const now = Date.now();
	const handle: ChildHandle = {
		id: opts.childId,
		session,
		status: "running",
		cwd: opts.cwd,
		ownerSession: opts.parentSessionId,
		description: opts.description,
		tools: activeTools,
		turns: priorTurns,
		createdAt: now,
		lastActiveAt: now,
	};
	register(handle);
	return handle;
}

export async function runTurn(opts: {
	handle: ChildHandle;
	parentSessionId: string;
	prompt: string;
	signal: AbortSignal | undefined;
	resumed: boolean;
	/** Task summary echoed back in every progress update. */
	description?: string;
	/** Progress sink: called on each child step, tool call and assistant text. */
	onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
}): Promise<ChildOutcome> {
	const agentDir = getAgentDir();
	const { handle } = opts;
	const session = handle.session;
	// Messages already on record before this turn: the transcript only renders
	// the new slice, and the final answer must come from this turn alone.
	const baseline = session.agent.state.messages.length;
	handle.status = "running";
	handle.lastActiveAt = Date.now();

	// Track the child's activity (steps, tokens, texts, tool calls) and push
	// it to the parent's UI as partial tool results.
	const activity: ChildActivity[] = [];
	let steps = 0;
	let liveTokens = 0;
	const emit = () => {
		trimActivity(activity);
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
	const failureGuard = new FailureGuard();
	let guardedFailure: string | undefined;
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
			failureGuard.start(event.toolCallId, event.toolName, event.args);
			activity.push({
				kind: "tool",
				toolCallId: event.toolCallId,
				name: event.toolName,
				label: childToolLabel(event.toolName, event.args),
				status: "running",
			});
			emit();
		} else if (event.type === "tool_execution_end") {
			const trip = failureGuard.end(event.toolCallId, event.toolName, event.result, event.isError);
			if (trip) {
				guardedFailure =
					`确定性工具失败循环保护：${trip.tool} / ${trip.kind}；` +
					`连续 ${trip.consecutive} 次执行前拒绝，其中连续同形 ${trip.identical} 次，已停止本轮。` +
					`历史与转录保留；请修正参数或指令后显式调用 agent(resume="${handle.id}", prompt="修正后的指令")，不要原样自动重试。`;
				resetIdleTimer();
				// Do not await abort inside event dispatch: it waits for this same session to settle.
				void session.abort().catch(() => {
					// The run still waits for idle; retain the original deterministic failure reason.
				});
			}
			for (let i = activity.length - 1; i >= 0; i--) {
				const entry = activity[i];
				if (entry.kind === "tool" && entry.toolCallId === event.toolCallId) {
					entry.status = event.isError ? "error" : "success";
					break;
				}
			}
			emit();
		} else if (event.type === "compaction_start" || event.type === "compaction_end") {
			// The child compacts on its own; surface it so the card explains the
			// context swap instead of showing one unbroken feed.
			applyCompactionActivity(activity, event);
			emit();
		}
	});

	let stalled = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	function resetIdleTimer(): void {
		if (idleTimer) clearTimeout(idleTimer);
		if (guardedFailure) return;
		idleTimer = setTimeout(() => {
			stalled = true;
			void session.abort();
		}, IDLE_TIMEOUT_MS);
	}
	resetIdleTimer();
	const onAbort = () => void session.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	let thrown: unknown;
	try {
		// Check after installing the listener: an already-aborted signal never starts a prompt.
		if (opts.signal?.aborted) {
			await session.abort();
		} else if (opts.resumed && !session.isIdle) {
			await session.followUp(opts.prompt);
		} else {
			await session.prompt(opts.prompt);
		}
		await session.waitForIdle();
	} catch (err) {
		// A failed turn still leaves usable history behind, and the child stays
		// resumable. Record it and fall through to build a partial outcome
		// rather than losing the work to an exception.
		thrown = err;
		await session.waitForIdle();
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
		opts.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	const allMessages = session.agent.state.messages;
	const turnMessages = allMessages.slice(baseline);
	let turns = 0;
	let tokens = 0;
	for (const m of allMessages) {
		if (m.role === "assistant") {
			turns++;
			tokens += m.usage?.input ?? 0;
			tokens += m.usage?.output ?? 0;
		}
	}
	const last = [...turnMessages].reverse().find((m) => m.role === "assistant");
	// A failing turn almost never throws: the session records it as an assistant
	// message with stopReason "error" and resolves normally. Reading only the
	// thrown value made every provider fault look like a silent empty reply.
	const erroredMessage = last?.stopReason === "error" ? last : undefined;
	const failed =
		guardedFailure ??
		(thrown
			? thrown instanceof Error
				? thrown.message
				: String(thrown)
			: erroredMessage
				? ((erroredMessage as { errorMessage?: string }).errorMessage ?? "provider 报错（未提供详细信息）")
				: undefined);
	const raw = last ? assistantText(last) : "(子 agent 未产生回复)";
	const truncated = raw.length > MAX_RESULT_CHARS;
	const text = truncated
		? `${raw.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${raw.length - MAX_RESULT_CHARS} chars]`
		: raw;
	const aborted = (opts.signal?.aborted ?? false) || (!guardedFailure && !stalled && last?.stopReason === "aborted");

	handle.turns += 1;
	handle.lastActiveAt = Date.now();
	handle.status = failed ? "failed" : stalled ? "stalled" : "idle";

	const outcome = failed
		? `报错中断：${failed}`
		: stalled
			? `静默超过 ${IDLE_TIMEOUT_MS / 60_000} 分钟被中止`
			: aborted
				? "被用户中止"
				: "正常结束";

	// Written for every ending, not just the bad ones: the parent may also want
	// the full process behind a truncated but successful answer.
	const transcriptPath = appendTranscript(
		childTranscriptPath(handle.cwd, opts.parentSessionId, handle.id, agentDir),
		renderTranscript(turnMessages, {
			prompt: opts.prompt,
			description: opts.description ?? handle.description,
			tools: handle.tools,
			outcome,
			turn: handle.turns,
		}),
	);

	return {
		text,
		tools: [...handle.tools],
		turns,
		tokens,
		truncated,
		stalled,
		aborted,
		failed,
		activity,
		transcriptPath,
		childId: handle.id,
		resumed: opts.resumed,
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

export function formatOutcome(outcome: ChildOutcome, description?: string): AgentToolResult<SubagentDetails> {
	const details: SubagentDetails = {
		description,
		tools: outcome.tools,
		aborted: outcome.aborted,
		turns: outcome.turns,
		tokens: outcome.tokens,
		truncated: outcome.truncated,
		stalled: outcome.stalled,
		activity: outcome.activity,
		transcriptPath: outcome.transcriptPath,
		childId: outcome.childId,
		resumed: outcome.resumed,
		failed: outcome.failed,
	};
	// A cut-short or truncated child still did real work. Returning an
	// error here makes the parent model discard all of it and retry from
	// scratch, so hand back the partial answer plus a pointer to the full
	// transcript and let the parent decide what to do.
	const pointer = outcome.transcriptPath
		? `\n\n（完整过程转录：${outcome.transcriptPath}，可用 read/grep 自行查看）`
		: "";
	// Every ending repeats the id: a stalled or truncated child is exactly
	// when the parent most needs to know it can resume instead of restart.
	const resumeHint = `\n\n（子 agent id：${outcome.childId}，实际工具：${outcome.tools.join(", ") || "无"}，用 agent(resume="${outcome.childId}", prompt="…") 可让它接着干）`;
	// A thrown turn is the case the parent most needs spelled out: without
	// the reason it only sees "no reply" and cannot tell a provider blip
	// (resume as-is) from a bad instruction (change the prompt first).
	if (outcome.failed) {
		return {
			content: [
				{
					type: "text",
					text:
						`子 agent 本轮报错中断：${outcome.failed}\n` +
						`已完成 ${outcome.turns} 轮，之前的上下文没有丢。中断前的最后一段输出：\n${outcome.text}${pointer}${resumeHint}`,
				},
			],
			details,
		};
	}
	if (outcome.aborted) {
		return {
			content: [
				{
					type: "text",
					text: `子 agent 已中止（已运行 ${outcome.turns} 轮）。部分结果：\n${outcome.text}${pointer}${resumeHint}`,
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
						`中止前的最后一段输出：\n${outcome.text}${pointer}${resumeHint}`,
				},
			],
			details,
		};
	}
	const head = description ? `【${description}】\n` : "";
	return {
		content: [
			{
				type: "text",
				text: `${head}${outcome.text}${outcome.truncated ? pointer : ""}${resumeHint}`,
			},
		],
		details,
	};
}
