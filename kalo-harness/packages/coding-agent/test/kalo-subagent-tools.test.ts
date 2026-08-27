import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import webFetchExtension from "../src/extensions/webfetch/index.ts";

/**
 * The subagent extension builds child sessions with `noExtensions: true`, which
 * strips every disk-discovered extension. web_fetch is an extension tool, so
 * children could not go online at all until webfetch was injected as an inline
 * factory — the case this mirrors. Keep it in sync with getChildResources() in
 * src/extensions/subagent/index.ts.
 */
describe("kalo subagent child toolset", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-kalo-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createChildSession(tools: string[]) {
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [{ name: "webfetch", factory: webFetchExtension, hidden: true }],
		});
		await resourceLoader.reload();

		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				tools,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
			})
		).session;
	}

	it("registers web_fetch despite noExtensions", async () => {
		const session = await createChildSession(["read", "grep", "glob", "ls", "web_fetch"]);
		expect(session.getActiveToolNames().sort()).toEqual(["glob", "grep", "ls", "read", "web_fetch"]);
		expect(session.systemPrompt).toContain("web_fetch");
		session.dispose();
	});

	it("still keeps recursion, MCP and memory out of the child", async () => {
		const session = await createChildSession(["read", "web_fetch"]);
		const allToolNames = session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).toContain("web_fetch");
		expect(allToolNames).not.toContain("agent");
		expect(allToolNames).not.toContain("todo_write");
		session.dispose();
	});

	it("honours an explicit tools list that omits web_fetch", async () => {
		const session = await createChildSession(["read", "grep"]);
		expect(session.getActiveToolNames().sort()).toEqual(["grep", "read"]);
		session.dispose();
	});
});
