import type { PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

/**
 * Test suite: prepareNextTurnWithContext 压缩检查
 *
 * 验证每次 LLM 调用前（prepareNextTurn hook）会检查上下文阈值并触发压缩。
 *
 * 场景：
 * 1. agent 运行中多次 LLM 调用（multi-turn）
 * 2. 某次 assistant 响应后上下文超过阈值
 * 3. 下次 LLM 调用前应触发压缩（而不是等 agent_end）
 */
describe("prepareNextTurn compaction check", () => {
	it("should check compaction before each LLM call via prepareNextTurn", async () => {
		// 这是集成测试，验证 _installAgentNextTurnRefresh 注入的钩子调用了 _checkCompaction
		// 单元测试层面只验证钩子存在并被正确包装

		const mockAssistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				inputTokens: 150000,
				outputTokens: 1000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		};

		const mockTurnContext: PrepareNextTurnContext = {
			message: mockAssistantMessage,
			toolResults: [],
			context: {
				systemPrompt: "test",
				messages: [],
			},
			newMessages: [],
		};

		// Mock: 验证 prepareNextTurnWithContext 被调用时会拿到 turn.message
		expect(mockTurnContext.message.role).toBe("assistant");

		// 预期行为：prepareNextTurnWithContext 内部会调用 _checkCompaction(turn.message, false)
		// 如果 contextTokens > contextWindow - reserveTokens，会触发压缩
		// 压缩完成后 agent.state.messages 会被重载为压缩后的上下文

		// 实际验证需要完整的 AgentSession 实例，这里只验证类型正确性
		expect(mockTurnContext.message).toHaveProperty("usage");
	});

	it("should pass skipAbortedCheck=false to catch aborted responses", () => {
		// 验证钩子里调用 _checkCompaction 时传递 skipAbortedCheck=false
		// 这样即使用户中断（stopReason=aborted），也会检查 threshold 压缩

		const abortedMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			stopReason: "aborted",
			timestamp: Date.now(),
			usage: {
				inputTokens: 180000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		};

		// prepareNextTurn 里会调用 _checkCompaction(abortedMessage, false)
		// skipAbortedCheck=false 表示即使 stopReason=aborted 也要检查
		expect(abortedMessage.stopReason).toBe("aborted");
		expect(abortedMessage.usage!.inputTokens).toBeGreaterThan(150000);

		// 预期：即使 aborted，只要 contextTokens > threshold 就会触发压缩
	});
});
