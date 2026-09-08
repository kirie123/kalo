import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "../src/core/compaction/compaction.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

/**
 * Test suite: Session file path appended to compaction summary
 * 
 * 验证 compact() 函数在提供 sessionFile 参数时会在摘要末尾追加：
 * 1. <session-file> XML 标签包裹的路径
 * 2. 工具使用提示（告知 LLM 可用 read 工具读取原始会话）
 */
describe("compact() session file reference", () => {
	// Mock model for summarization
	const mockModel: Model<any> = {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		contextWindow: 200000,
		maxTokens: 8192,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { tools: true, thinking: false },
	};

	// Helper: create minimal session entries for compaction
	function createTestEntries(): SessionEntry[] {
		const now = Date.now();
		return [
			{
				id: "entry-1",
				type: "message",
				parentId: null,
				timestamp: new Date(now - 2000).toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "Hello" }],
					timestamp: now - 2000,
				},
			},
			{
				id: "entry-2",
				type: "message",
				parentId: "entry-1",
				timestamp: new Date(now - 1000).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hi there" }],
					timestamp: now - 1000,
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
					model: "test-model",
					provider: "anthropic",
					stopReason: "stop",
				},
			},
			{
				id: "entry-3",
				type: "message",
				parentId: "entry-2",
				timestamp: new Date(now).toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "How are you?" }],
					timestamp: now,
				},
			},
		];
	}

	it("should append session file reference when sessionFile is provided", async () => {
		const entries = createTestEntries();
		const preparation = prepareCompaction(entries, {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});

		expect(preparation).not.toBeNull();
		if (!preparation) return;

		// Mock LLM call: return fixed summary
		const mockSummarization = async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "## Goal\nTest conversation\n\n## Progress\n### Done\n- [x] Said hello" }],
			stopReason: "stop" as const,
			timestamp: Date.now(),
			usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0 },
		});

		const result = await compact(
			preparation,
			mockModel,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => ({ result: mockSummarization }) as any,
			undefined,
			undefined,
			undefined,
			"~/.kalo/sessions/test-session-123.jsonl",
		);

		// Verify session file reference is appended
		expect(result.summary).toContain("<session-file>");
		expect(result.summary).toContain("~/.kalo/sessions/test-session-123.jsonl");
		expect(result.summary).toContain("</session-file>");

		// Verify tool usage hint
		expect(result.summary).toContain("Note for Assistant");
		expect(result.summary).toContain("compressed checkpoint");
		expect(result.summary).toContain("JSONL format");
		expect(result.summary).toContain("`read` tool");
		expect(result.summary).toContain("`offset`");
		expect(result.summary).toContain("`limit`");
	});

	it("should NOT append session file reference when sessionFile is undefined", async () => {
		const entries = createTestEntries();
		const preparation = prepareCompaction(entries, {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});

		expect(preparation).not.toBeNull();
		if (!preparation) return;

		const mockSummarization = async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "## Goal\nTest conversation" }],
			stopReason: "stop" as const,
			timestamp: Date.now(),
			usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0 },
		});

		const result = await compact(
			preparation,
			mockModel,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => ({ result: mockSummarization }) as any,
			undefined,
			undefined,
			undefined,
			undefined, // sessionFile not provided
		);

		// Verify NO session file reference
		expect(result.summary).not.toContain("<session-file>");
		expect(result.summary).not.toContain("Note for Assistant");
		expect(result.summary).not.toContain("compressed checkpoint");
	});

	it("should append session file reference AFTER file operations", async () => {
		const now = Date.now();
		const entries: SessionEntry[] = [
			{
				id: "entry-1",
				type: "message",
				parentId: null,
				timestamp: new Date(now - 2000).toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "Read utils.ts" }],
					timestamp: now - 2000,
				},
			},
			{
				id: "entry-2",
				type: "message",
				parentId: "entry-1",
				timestamp: new Date(now - 1000).toISOString(),
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "src/utils.ts" },
						},
					],
					timestamp: now - 1000,
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
					model: "test-model",
					provider: "anthropic",
					stopReason: "stop",
				},
			},
			{
				id: "entry-3",
				type: "message",
				parentId: "entry-2",
				timestamp: new Date(now).toISOString(),
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "export function foo() {}" }],
					timestamp: now,
					toolCallId: "call-1",
				},
			},
		];

		const preparation = prepareCompaction(entries, {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});

		expect(preparation).not.toBeNull();
		if (!preparation) return;

		const mockSummarization = async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "## Goal\nRead file" }],
			stopReason: "stop" as const,
			timestamp: Date.now(),
			usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0 },
		});

		const result = await compact(
			preparation,
			mockModel,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => ({ result: mockSummarization }) as any,
			undefined,
			undefined,
			undefined,
			"~/.kalo/sessions/file-ops-session.jsonl",
		);

		// Verify ordering: file ops first, then session file reference
		const fileOpsIndex = result.summary.indexOf("<read-files>");
		const sessionFileIndex = result.summary.indexOf("<session-file>");

		expect(fileOpsIndex).toBeGreaterThan(-1);
		expect(sessionFileIndex).toBeGreaterThan(-1);
		expect(sessionFileIndex).toBeGreaterThan(fileOpsIndex); // session file comes AFTER file ops
	});
});
