import { homedir } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskClient } from "../../src/extensions/task-runtime/client.ts";
import taskRuntimeExtension from "../../src/extensions/task-runtime/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("task runtime with the real AgentSession and offline faux model", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function setup(role: "router" | "worker") {
		vi.stubEnv("KALO_TASK_ROLE", role);
		vi.stubEnv("KALO_TASK_ENDPOINT", "http://127.0.0.1:12345");
		vi.stubEnv("KALO_TASK_TOKEN", "test-run-token");
		vi.stubEnv("KALO_TASK_ALLOW_SHELL", "0");
		const executions: string[] = [];
		const tools: AgentTool[] = ["write", "read", "bash"].map((name) => ({
			name,
			label: name,
			description: "Test-only inert tool",
			parameters: Type.Object({ path: Type.Optional(Type.String()) }),
			async execute() {
				executions.push(name);
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		}));
		const calls: { operation: string; body: unknown }[] = [];
		const request = vi.spyOn(TaskClient.prototype, "request").mockImplementation(async (operation, body) => {
			calls.push({ operation, body });
			return operation === "context" ? { goal: "测试目标", acceptance: "实际证据" } : { recorded: true };
		});
		const harness = await createHarness({ tools, extensionFactories: [taskRuntimeExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(calls.some((c) => c.operation === "context" && JSON.stringify(c.body).includes('"protocol":1'))).toBe(
			true,
		);
		return { harness, calls, request, executions };
	}

	it("Router can decide but cannot execute file or shell tools", async () => {
		const { harness, calls, executions } = await setup("router");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "x" }), fauxToolCall("bash", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("task_decide", {
						decision: "create",
						title: "测试",
						goal: "测试目标",
						acceptance: "实际证据",
						reason: "委托明确",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("接单完成"),
		]);
		await harness.session.prompt("执行任务");
		expect(executions).toEqual([]);
		expect(calls.filter((c) => c.operation === "decide")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(
			harness.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult"),
		).not.toHaveLength(0);
	});

	it("asking persists the tool result, blocks later effects, and settles without waiting for a human", async () => {
		const { harness, calls, executions } = await setup("worker");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("task_ask", { question: "哪种格式？", options: ["Markdown"] }),
					fauxToolCall("write", { path: "after.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("等待回答"),
		]);
		await harness.session.prompt("整理资料");
		expect(calls.filter((c) => c.operation === "ask")).toHaveLength(1);
		expect(executions).toEqual([]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(e) =>
						e.type === "message" &&
						e.message.role === "toolResult" &&
						e.message.toolName === "task_ask" &&
						!e.message.isError,
				),
		).toBe(true);
	});

	it("revoked authorization prevents file execution and failed gates are visible to the model", async () => {
		const { harness, request, executions } = await setup("worker");
		request.mockImplementation(async (operation) => {
			if (operation === "gate") throw new Error("任务已停止");
			return {};
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("已停止"),
		]);
		await harness.session.prompt("执行任务");
		expect(executions).toEqual([]);
		expect(
			harness.session.messages.some(
				(m) => m.role === "toolResult" && m.isError && JSON.stringify(m).includes("任务已停止"),
			),
		).toBe(true);
	});

	it("gate receives the engine-resolved home path, not a misleading relative tilde path", async () => {
		const { harness, calls, request, executions } = await setup("worker");
		request.mockImplementation(async (operation, body) => {
			calls.push({ operation, body });
			if (operation === "gate") throw new Error("目录之外");
			return {};
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "@~" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("拒绝"),
		]);
		await harness.session.prompt("读取文件");
		expect(calls.find((c) => c.operation === "gate")?.body).toEqual({ tool: "read", input: { path: homedir() } });
		expect(executions).toEqual([]);
	});

	it("KALO_TASK_TOOLS narrows the worker tool set and never widens it", async () => {
		// The gateway sends the profile's allowlist; bash is absent from both the list and the ceiling.
		vi.stubEnv("KALO_TASK_TOOLS", "read,task_report,task_ask,task_context,bash");
		const { harness, executions } = await setup("worker");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "x" }), fauxToolCall("bash", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("task_report", { state: "ready", summary: "已读资料" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("交付完成"),
		]);
		await harness.session.prompt("只读任务");
		// A narrowed set removes tools; a listed tool the engine never had (bash without allowShell) stays gone.
		expect(executions).toEqual([]);
		const active = harness.session.getActiveToolNames?.() ?? [];
		expect(active).not.toContain("write");
		expect(active).not.toContain("bash");
	});
});
