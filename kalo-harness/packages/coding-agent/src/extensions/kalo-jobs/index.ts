/**
 * kalo-jobs extension — the model-facing layer over the gateway's job runtime.
 *
 * Three tools, deliberately not five:
 *   job_list                      what is running for this session
 *   job_output(id, wait?)         read new output, optionally blocking
 *   job_kill(id, reason?)         stop one
 *
 * There is no job_start: jobs are created by whoever owns the work (the
 * desktop panel, a schedule, a producer), and the model only observes and
 * stops them. Keeping start out of the tool surface is what stops "run a
 * command" from quietly becoming "run a command forever".
 *
 * Completion is pushed, not polled. A background drain asks the gateway for
 * terminal jobs this session has not been told about and injects them:
 *   busy  → sendMessage(deliverAs: "nextTurn")   — waits for the current turn
 *   idle  → sendMessage(triggerTurn: true)       — wakes the agent, bounded
 * That is what removes `sleep 300` loops from long-running work.
 *
 * All job semantics (owner fencing, gates, health, metrics) live in the
 * gateway; this file is tools + notification.
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { JobsClient, type JobSnapshot } from "./client.ts";

/** How often the drain asks the gateway for unreported completions. */
const POLL_MS = 5_000;
/** Consecutive agent wakes allowed without any user input in between. */
const MAX_CONSECUTIVE_WAKES = 3;
/** Default and ceiling for a blocking job_output. */
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 600_000;

const STATUS_TEXT: Record<string, string> = {
	queued: "等待门控",
	running: "运行中",
	stopping: "停止中",
	completed: "已完成",
	killed: "已停止",
	failed: "失败",
};

/** One details shape across the three tools, so every branch stays comparable. */
interface JobToolDetails {
	count?: number;
	jobs?: JobSnapshot[];
	job?: JobSnapshot;
	result?: string;
	bytes?: number;
	error?: string;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function describe(job: JobSnapshot): string {
	const detail = job.detail ? ` — ${job.detail}` : "";
	return `[${job.id}] ${job.label} · ${STATUS_TEXT[job.status] ?? job.status}${detail}`;
}

export default function kaloJobsExtension(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	const client = new JobsClient({ session: () => sessionId });

	// ---------------------------------------------------------------- tools

	pi.registerTool({
		name: "job_list",
		label: "Job List",
		description:
			"List the background jobs belonging to this session (id, label, status). " +
			"Jobs run in the Kalo gateway and outlive this session.",
		promptSnippet: "job_list() — 查看本会话的后台任务",
		parameters: Type.Object({}),
		async execute(): Promise<AgentToolResult<JobToolDetails>> {
			try {
				const jobs = await client.list();
				if (jobs.length === 0) {
					return { content: [{ type: "text", text: "没有后台任务。" }], details: { count: 0 } };
				}
				return {
					content: [{ type: "text", text: jobs.map(describe).join("\n") }],
					details: { count: jobs.length, jobs },
				};
			} catch (err) {
				return { content: [{ type: "text", text: `job_list 失败：${errText(err)}` }], details: { error: errText(err) } };
			}
		},
	});

	pi.registerTool({
		name: "job_output",
		label: "Job Output",
		description:
			"Read the output a background job produced since your last read. " +
			"With wait=true it blocks until the job finishes or the timeout elapses — use that instead of sleeping in a loop.",
		promptSnippet: "job_output(job_id, wait?, timeout_ms?) — 读取后台任务的新输出",
		promptGuidelines: [
			"等待后台任务时用 job_output(wait=true)，不要用 sleep 轮询",
			"任务结束时系统会主动通知你，不需要反复查询",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "任务 id，如 gateway-3" }),
			wait: Type.Optional(Type.Boolean({ description: "true 表示阻塞到任务结束或超时" })),
			timeout_ms: Type.Optional(Type.Number({ description: `wait 时的超时（毫秒），默认 ${DEFAULT_WAIT_MS}` })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<JobToolDetails>> {
			try {
				const timeoutMs = Math.min(Math.max(Number(params.timeout_ms) || DEFAULT_WAIT_MS, 1), MAX_WAIT_MS);
				const { text, job } = await client.output(params.job_id, { wait: params.wait === true, timeoutMs });
				const head = describe(job);
				return {
					content: [{ type: "text", text: text ? `${head}\n\n${text}` : `${head}\n（没有新输出）` }],
					details: { job, bytes: text.length },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `job_output 失败：${errText(err)}` }],
					details: { error: errText(err) },
				};
			}
		},
	});

	pi.registerTool({
		name: "job_kill",
		label: "Job Kill",
		description: "Stop a background job. Stopping an already finished job is not an error.",
		promptSnippet: "job_kill(job_id, reason?) — 停止一个后台任务",
		parameters: Type.Object({
			job_id: Type.String({ description: "任务 id" }),
			reason: Type.Optional(Type.String({ description: "停止原因，会记录到任务详情" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<JobToolDetails>> {
			try {
				const { result, job } = await client.kill(params.job_id, params.reason);
				const text = result === "already-finished" ? `[${job.id}] 已经结束了。` : `[${job.id}] 已请求停止。`;
				return { content: [{ type: "text", text }], details: { result, job } };
			} catch (err) {
				return { content: [{ type: "text", text: `job_kill 失败：${errText(err)}` }], details: { error: errText(err) } };
			}
		},
	});

	// -------------------------------------------------- completion notifier

	let timer: ReturnType<typeof setInterval> | null = null;
	let draining = false;
	let wakes = 0;

	async function drain(ctx: ExtensionContext): Promise<void> {
		// One drain at a time: a slow gateway must not queue up claims, each of
		// which would consume completions the previous one is still delivering.
		if (draining) return;
		draining = true;
		try {
			const jobs = await client.claimCompletions();
			if (jobs.length === 0) return;
			const body = ["后台任务结束：", ...jobs.map(describe), "", "需要的话用 job_output 读取它们的输出。"].join("\n");
			const idle = ctx.isIdle();
			if (idle && wakes >= MAX_CONSECUTIVE_WAKES) {
				// Bounded wakes: keep telling the model, but stop driving turns
				// until the user says something. Prevents a wake loop.
				pi.sendMessage({ customType: "kalo-job-done", content: body, display: true }, { deliverAs: "nextTurn" });
				return;
			}
			if (idle) wakes += 1;
			pi.sendMessage(
				{ customType: "kalo-job-done", content: body, display: true },
				idle ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "nextTurn" },
			);
		} catch {
			// No gateway, or a restarting one: silence is correct here — the drain
			// is background bookkeeping and must never surface as a session error.
		} finally {
			draining = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		if (timer) clearInterval(timer);
		// Only poll when a gateway is actually publishing an endpoint; a plain
		// terminal pi run should not tick forever against a missing file.
		timer = setInterval(() => {
			if (!client.available()) return;
			void drain(ctx);
		}, POLL_MS);
		// Never hold the process open for a background drain.
		(timer as { unref?: () => void }).unref?.();
	});

	// A user message means the human is present again: wake budget resets.
	pi.on("input", () => {
		wakes = 0;
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = null;
	});
}
