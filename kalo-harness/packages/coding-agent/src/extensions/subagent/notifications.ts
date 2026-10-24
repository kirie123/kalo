import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { type BackgroundTaskRecord, backgroundTasks } from "./background.ts";
import { childSessionDir } from "./children.ts";

const DONE_MESSAGE_TYPE = "kalo-subagent-done";
const STATUS_KEY = "kalo-subagent-background";
const MAX_AUTOMATIC_WAKES = 3;
const MAX_NOTIFICATION_TASKS = 20;
const MAX_LIST_TASKS = 50;
const MAX_BODY_CHARS = 12_000;
const FOOTER = "\n使用 agent_tasks(action=output, run_id=...) 读取单条完整结果及转录路径。";

interface Delivery {
	runIds: string[];
	accepted: boolean;
	assistant?: AssistantMessage;
}

interface Binding {
	generation: number;
	ctx: ExtensionContext;
	manager: ExtensionContext["sessionManager"];
	owner: string;
	cwd: string;
	directory: string;
	wakes: number;
	blocked: boolean;
	reading: boolean;
	scheduled: boolean;
	awaitingPrompt: boolean;
	records: BackgroundTaskRecord[];
	error?: string;
	delivery?: Delivery;
	unsubscribe?: () => void;
}

interface AgentTasksDetails {
	count?: number;
	shown?: number;
	truncated?: boolean;
	// List metadata must not smuggle full result bodies into the tool response.
	tasks?: { runId: string; status: string; summary: string }[];
	task?: BackgroundTaskRecord;
	error?: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function terminal(record: BackgroundTaskRecord): boolean {
	return record.status !== "queued" && record.status !== "running";
}

function pathKey(path: string): string {
	let absolute = resolve(path);
	try {
		absolute = realpathSync.native(absolute);
	} catch {
		// The cwd may not exist yet; resolve still gives a stable comparison key.
	}
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function directoryKey(path: string): string {
	try {
		return pathKey(realpathSync.native(path));
	} catch {
		return pathKey(path);
	}
}

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function taskLine(record: BackgroundTaskRecord): string {
	return `${record.runId} · ${clip(record.childId, 100)} · ${record.status} · ${clip(record.description ?? "", 120)}`;
}

function resultText(record: BackgroundTaskRecord): string {
	const result = record.result;
	const parts = [result?.text || "（暂无正文）"];
	if (result?.failed !== undefined) parts.push(`错误：${result.failed}`);
	if (result?.aborted) parts.push("已中止");
	if (result?.stalled) parts.push("执行卡住");
	if (result?.transcriptPath) parts.push(`转录：${result.transcriptPath}`);
	if (record.persistenceError) parts.push(`存储错误：${record.persistenceError}`);
	return parts.join("\n");
}

function taskSummary(record: BackgroundTaskRecord): string {
	const parts = [taskLine(record)];
	if (record.result?.text) parts.push(`摘要：${clip(record.result.text, 300)}`);
	if (record.result?.failed !== undefined) parts.push(`错误：${clip(record.result.failed, 200)}`);
	if (record.result?.transcriptPath) parts.push(`转录：${clip(record.result.transcriptPath, 300)}`);
	if (record.persistenceError) parts.push(`存储错误：${clip(record.persistenceError, 200)}`);
	return parts.join("\n");
}

/** Only included records may be acknowledged; never truncate a whole batch after selecting runIds. */
function summarize(records: BackgroundTaskRecord[], limit: number) {
	const selected: BackgroundTaskRecord[] = [];
	let body = `后台子 agent：共 ${records.length} 个任务/结果\n`;
	for (const record of records) {
		const summary = `${taskSummary(record)}\n`;
		if (selected.length >= limit || body.length + summary.length + FOOTER.length + 100 > MAX_BODY_CHARS) break;
		selected.push(record);
		body += summary;
	}
	if (selected.length < records.length)
		body += `另有 ${records.length - selected.length} 个未展示，仍保留待查询/投递。\n`;
	return { selected, body: body + FOOTER };
}

/** At-least-once delivery: durable record -> custom message_end -> successful assistant -> settled -> ack. */
export function registerBackgroundNotifications(pi: ExtensionAPI): void {
	let current: Binding | undefined;
	let generation = 0;

	function active(binding: Binding): boolean {
		return current === binding && binding.generation === generation;
	}

	function matches(ctx: ExtensionContext): Binding | undefined {
		const binding = current;
		if (!binding || !active(binding)) return undefined;
		try {
			return ctx.sessionManager === binding.manager &&
				ctx.sessionManager.getSessionId() === binding.owner &&
				pathKey(ctx.cwd) === binding.cwd
				? binding
				: undefined;
		} catch {
			return undefined; // Invalidated runner contexts have throwing getters.
		}
	}

	function status(binding: Binding): void {
		if (!active(binding)) return;
		const running = binding.records.filter((record) => !terminal(record)).length;
		const pending = binding.records.filter((record) => terminal(record) && !record.acknowledged).length;
		try {
			binding.ctx.ui.setStatus(
				STATUS_KEY,
				binding.error
					? `后台子 agent：存储错误：${clip(binding.error, 300)}（保留待处理）`
					: running + pending > 0
						? `后台子 agent：${running} 个运行中，${pending} 个结果待处理`
						: undefined,
			);
		} catch {
			// A runner can be invalidated between active() and this status update.
		}
	}

	function scan(binding: Binding): void {
		if (!active(binding) || binding.reading) return;
		binding.reading = true;
		const previousRecords = binding.records;
		binding.error = undefined;
		try {
			const nextRecords = backgroundTasks.list(binding.directory, binding.owner);
			// list emits read errors synchronously. Keep the last complete snapshot instead of
			// replacing it with a partial list, while still exposing the error and keeping alive.
			const eventError = binding.error;
			const recordError = nextRecords.find((record) => record.persistenceError)?.persistenceError;
			binding.records = eventError ? previousRecords : nextRecords;
			binding.error = eventError ?? recordError;
		} catch (error) {
			binding.records = previousRecords;
			binding.error = errorText(error); // Retain the last known snapshot and keep-alive.
		} finally {
			binding.reading = false;
		}
		status(binding);
	}

	function schedule(binding: Binding): void {
		if (!active(binding) || binding.scheduled) return;
		binding.scheduled = true;
		queueMicrotask(() => {
			if (!active(binding)) return; // Do not read stale ctx getters or clear another session's UI.
			binding.scheduled = false;
			drain(binding);
		});
	}

	function prepare(binding: Binding): BeforeAgentStartEventResult["message"] {
		if (!active(binding)) return;
		scan(binding);
		if (binding.error || binding.blocked || binding.delivery || binding.wakes >= MAX_AUTOMATIC_WAKES) return;
		const pending = binding.records.filter((record) => terminal(record) && !record.acknowledged);
		if (!pending.length) return;
		const batch = summarize(pending, MAX_NOTIFICATION_TASKS);
		const delivery: Delivery = { runIds: batch.selected.map((record) => record.runId), accepted: false };
		binding.delivery = delivery;
		binding.wakes++; // Injected messages and busy followUps consume the same budget as idle wakeups.
		return {
			customType: DONE_MESSAGE_TYPE,
			content: batch.body,
			display: true,
			details: { runIds: delivery.runIds },
		};
	}

	function drain(binding: Binding): void {
		// input/before_agent_start run before AgentSession has submitted its prompt.
		// Even a previously queued drain or a background change must not steal that turn.
		if (!active(binding) || binding.awaitingPrompt) return;
		const message = prepare(binding);
		if (!message) return;
		try {
			pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			if (!active(binding)) return;
			binding.blocked = true;
			if (!binding.delivery?.accepted) binding.delivery = undefined;
			// A void API has no async failure receipt. Unaccepted sends replay on real input/restart.
		}
	}

	function detach(): void {
		const binding = current;
		current = undefined;
		generation++;
		binding?.unsubscribe?.();
		try {
			binding?.ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// The previous runner may already have been invalidated during reload.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		detach();
		const owner = ctx.sessionManager.getSessionId();
		const binding: Binding = {
			generation,
			ctx,
			manager: ctx.sessionManager,
			owner,
			cwd: pathKey(ctx.cwd),
			directory: childSessionDir(ctx.cwd, owner, getAgentDir()),
			wakes: 0,
			blocked: false,
			reading: false,
			scheduled: false,
			awaitingPrompt: false,
			records: [],
		};
		current = binding;
		binding.unsubscribe = backgroundTasks.subscribe((event) => {
			if (!active(binding)) return;
			const owner = event.type === "change" ? event.record.owner : event.owner;
			if (owner !== binding.owner || directoryKey(event.directory) !== directoryKey(binding.directory)) return;
			if (event.type === "error") {
				binding.error = event.error.message;
				status(binding); // Never recursively list/retry from an error observer.
				return;
			}
			if (binding.reading) return;
			scan(binding);
			schedule(binding);
		});
		scan(binding);
		schedule(binding);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (matches(ctx)) detach();
	});
	pi.on("input", (event, ctx) => {
		const binding = matches(ctx);
		if (!binding || (event.source !== "interactive" && event.source !== "rpc")) return;
		binding.wakes = 0;
		binding.blocked = false;
		binding.awaitingPrompt = true;
		// No message_end receipt does not prove the in-memory followUp queue is empty.
		// Replay may duplicate a queued notification: delivery remains at least once.
		// Rejected/handled prompts leave results pending until a user message is received.
		if (!binding.delivery?.accepted) binding.delivery = undefined;
	});
	pi.on("before_agent_start", (_event, ctx): BeforeAgentStartEventResult | undefined => {
		const binding = matches(ctx);
		if (!binding) return;
		binding.awaitingPrompt = true;
		const message = prepare(binding);
		// AgentSession includes this alongside the user message in agent.prompt().
		// Returning it is not a receipt; only the agent loop's message_end accepts it.
		return message ? { message } : undefined;
	});
	pi.on("message_end", (event, ctx) => {
		const binding = matches(ctx);
		if (!binding) return;
		if (event.message.role === "user") {
			binding.awaitingPrompt = false;
			schedule(binding); // The prompt is now running; busy followUps cannot preempt it.
		}
		const delivery = binding.delivery;
		if (!delivery) return;
		const message = event.message;
		if (message.role === "custom" && message.customType === DONE_MESSAGE_TYPE) {
			const details: unknown = message.details;
			if (!details || typeof details !== "object" || !("runIds" in details)) return;
			const ids = details.runIds;
			if (
				Array.isArray(ids) &&
				ids.length === delivery.runIds.length &&
				delivery.runIds.every((id) => ids.includes(id))
			) {
				delivery.accepted = true;
				delivery.assistant = undefined;
			}
		} else if (delivery.accepted && message.role === "assistant") delivery.assistant = message;
	});
	pi.on("agent_settled", (_event, ctx) => {
		const binding = matches(ctx);
		const delivery = binding?.delivery;
		if (!binding || !delivery?.accepted) return;
		binding.delivery = undefined;
		// A truncated/tool-only/deferred/missing final answer is not successful completion.
		if (!delivery.assistant || delivery.assistant.stopReason !== "stop") {
			binding.blocked = true;
			scan(binding);
			return;
		}
		let ackFailed = false;
		for (const runId of delivery.runIds) {
			try {
				const acknowledged = backgroundTasks.ack(binding.directory, binding.owner, runId);
				if (!acknowledged?.acknowledged) throw new Error(`Unable to acknowledge ${runId}`);
			} catch {
				ackFailed = true;
				binding.blocked = true;
			} // Ack write failure must not immediately replay side effects.
		}
		if (ackFailed) {
			status(binding);
			return;
		}
		scan(binding);
		schedule(binding);
	});

	pi.registerTool({
		name: "agent_tasks",
		label: "Agent Tasks",
		promptSnippet:
			"agent_tasks(action: list|output|cancel, run_id?) — 查询本会话后台任务、读取完整结果或取消运行；output/cancel 需 run_id",
		description:
			"查询本会话后台子 agent。list 返回有界摘要（未确认结果优先），output 返回指定运行的完整结果/错误/转录路径，cancel 取消运行；查询不确认通知。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("output"), Type.Literal("cancel")]),
			run_id: Type.Optional(Type.String({ description: "output/cancel 必填" })),
		}),
		async execute(_id, params, _signal, _update, ctx): Promise<AgentToolResult<AgentTasksDetails>> {
			try {
				const owner = ctx.sessionManager.getSessionId();
				const directory = childSessionDir(ctx.cwd, owner, getAgentDir());
				if (params.action === "list") {
					const tasks = backgroundTasks
						.list(directory, owner)
						.sort((a, b) => Number(a.acknowledged) - Number(b.acknowledged));
					const batch = summarize(tasks, MAX_LIST_TASKS);
					return {
						content: [{ type: "text", text: batch.body }],
						details: {
							count: tasks.length,
							shown: batch.selected.length,
							truncated: batch.selected.length < tasks.length,
							tasks: batch.selected.map((task) => ({
								runId: task.runId,
								status: task.status,
								summary: taskSummary(task),
							})),
						},
					};
				}
				if (!params.run_id) throw new Error("output/cancel 需要 run_id");
				const task =
					params.action === "output"
						? backgroundTasks.get(directory, owner, params.run_id)
						: backgroundTasks.cancel(directory, owner, params.run_id);
				if (!task) throw new Error("任务不存在或不属于当前会话");
				return { content: [{ type: "text", text: `${taskLine(task)}\n${resultText(task)}` }], details: { task } };
			} catch (error) {
				return {
					content: [{ type: "text", text: `agent_tasks 失败：${errorText(error)}` }],
					details: { error: errorText(error) },
				};
			}
		},
	});
}
