import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { backgroundTasks } from "../src/extensions/subagent/background.ts";
import { type ChildHandle, childSessionDir, register, resetRegistry } from "../src/extensions/subagent/children.ts";
import { executeAgent } from "../src/extensions/subagent/index.ts";
import { formatOutcome, runTurn } from "../src/extensions/subagent/runner.ts";

const state = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("../src/config.ts", async (original) => ({ ...(await original<object>()), getAgentDir: () => state.agentDir }));
vi.mock("../src/core/sdk.ts", () => ({ createAgentSession: vi.fn() }));
const diagnostic =
	'Validation failed for tool "bash":\n  - command: must have required properties command\n\nReceived arguments:\n{}';
function setup() {
	state.agentDir = mkdtempSync(join(tmpdir(), "subagent-guard-run-"));
	const messages: AgentMessage[] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let budget = 6;
	let idle = true;
	const abort = vi.fn(async () => {});
	const session = {
		agent: { state: { messages } },
		get isIdle() {
			return idle;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		abort,
		waitForIdle: vi.fn(async () => {}),
		prompt: vi.fn(async () => {
			idle = false;
			const emit = (event: AgentSessionEvent) => {
				for (const listener of listeners) listener(event);
			};
			// All starts precede ends, as in a parallel tool batch; the batch can drain after abort.
			for (let i = 0; i < budget; i++)
				emit({ type: "tool_execution_start", toolCallId: String(i), toolName: "bash", args: {} });
			for (let i = 0; i < budget; i++) {
				const content = [{ type: "text" as const, text: diagnostic }];
				messages.push({
					role: "toolResult",
					toolCallId: String(i),
					toolName: "bash",
					content,
					isError: true,
					timestamp: 0,
				});
				emit({
					type: "tool_execution_end",
					toolCallId: String(i),
					toolName: "bash",
					result: { content },
					isError: true,
				});
			}
			messages.push({
				role: "assistant",
				content: [],
				stopReason: abort.mock.calls.length ? "aborted" : "stop",
				api: "openai-completions",
				provider: "test",
				model: "test",
				timestamp: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			idle = true;
		}),
	} as unknown as AgentSession;
	const handle: ChildHandle = {
		id: "subagent-9",
		session,
		status: "idle",
		cwd: state.agentDir,
		ownerSession: "owner",
		tools: ["bash"],
		turns: 0,
		createdAt: 0,
		lastActiveAt: 0,
	};
	register(handle);
	return {
		handle,
		abort,
		listeners,
		setBudget: (value: number) => {
			budget = value;
		},
	};
}
afterEach(() => {
	resetRegistry();
	if (state.agentDir) rmSync(state.agentDir, { recursive: true, force: true });
});

describe("child runner failure guard integration", () => {
	it("aborts once per batch, returns failed not cancelled, preserves transcript, and resets on explicit resume", async () => {
		const f = setup();
		const options = { handle: f.handle, parentSessionId: "owner", prompt: "run", signal: undefined, resumed: false };
		const outcome = await runTurn(options);
		expect(f.abort).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ aborted: false, stalled: false });
		expect(outcome.failed).toContain("连续同形 3 次");
		expect(outcome.failed).toContain('agent(resume="subagent-9"');
		expect(f.handle.status).toBe("failed");
		const firstTranscript = readFileSync(outcome.transcriptPath!, "utf8");
		expect(firstTranscript).toContain("确定性工具失败循环保护");
		expect(firstTranscript.match(/Validation failed for tool/g)).toHaveLength(6);
		expect(formatOutcome(outcome).details?.failed).toBe(outcome.failed);
		expect(f.listeners.size).toBe(0);
		f.abort.mockClear();
		f.setBudget(2);
		const resumed = await runTurn({ ...options, resumed: true, prompt: "corrected" });
		expect(resumed.failed).toBeUndefined();
		expect(f.abort).not.toHaveBeenCalled();
		expect(readFileSync(resumed.transcriptPath!, "utf8")).toContain(firstTranscript);
		expect(readFileSync(resumed.transcriptPath!, "utf8")).toContain("## 第 2 轮");
	});
	it("persists a guarded background run as failed with transcript and corrective resume instructions", async () => {
		const f = setup();
		const ctx = { cwd: state.agentDir, sessionManager: { getSessionId: () => "owner" } } as ExtensionContext;
		const directory = childSessionDir(state.agentDir, "owner", state.agentDir);
		let finish!: () => void;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const unsubscribe = backgroundTasks.subscribe((event) => {
			if (event.type === "change" && event.record.childId === f.handle.id && event.record.finishedAt !== undefined)
				finish();
		});
		try {
			const response = await executeAgent(
				"call",
				{ prompt: "run", resume: f.handle.id, run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			await done;
			const record = backgroundTasks.get(directory, "owner", response.details!.runId!);
			expect(record?.status).toBe("failed");
			expect(record?.result?.aborted).toBe(false);
			expect(record?.result?.failed).toContain("schema-validation");
			expect(record?.result?.text).toContain("不要原样自动重试");
			expect(readFileSync(record!.result!.transcriptPath!, "utf8")).toContain("确定性工具失败循环保护");
		} finally {
			unsubscribe();
		}
	});
});
