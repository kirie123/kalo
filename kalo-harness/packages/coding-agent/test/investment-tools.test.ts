import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { InvestmentClient } from "../src/extensions/investment/client.ts";
import investmentExtension from "../src/extensions/investment/index.ts";
import { decide } from "../src/extensions/permission/policy.ts";

interface Wire {
	id: string;
	version: number;
	token: string;
	command: { operation: string; jobId?: string; request?: unknown };
}
const cleanups: (() => Promise<void>)[] = [];
async function fixture(handler: (input: Wire, socket: Socket) => void) {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let text = "";
		socket.on("data", (data) => {
			text += data.toString();
			if (text.includes("\n")) handler(JSON.parse(text), socket);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return address.port;
}
function reply(input: Wire, socket: Socket, result: unknown) {
	socket.end(`${JSON.stringify({ version: 1, id: input.id, ok: true, result })}\n`);
}
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("investment tools", () => {
	it("frames split UTF-8 replies and rejects mismatched response IDs", async () => {
		const port = await fixture((input, socket) => {
			if (input.command.operation === "bad")
				return socket.end(`${JSON.stringify({ version: 1, id: "wrong", ok: true, result: {} })}\n`);
			const bytes = Buffer.from(`${JSON.stringify({ version: 1, id: input.id, ok: true, result: "资金证据" })}\n`);
			const split = bytes.indexOf(Buffer.from("资金")) + 1;
			socket.write(bytes.subarray(0, split));
			setTimeout(() => socket.end(bytes.subarray(split)), 10);
		});
		const client = new InvestmentClient(port, "token");
		expect(await client.request({ operation: "catalog" })).toBe("资金证据");
		await expect(client.request({ operation: "bad" })).rejects.toThrow("ID");
	});
	it("cancels a job even when abort races the start response", async () => {
		const controller = new AbortController();
		const operations: string[] = [];
		const port = await fixture((input, socket) => {
			operations.push(input.command.operation);
			if (input.command.operation === "start") {
				controller.abort();
				reply(input, socket, { jobId: "created" });
			} else {
				expect(input.command.jobId).toBe("created");
				reply(input, socket, {});
			}
		});
		await expect(
			new InvestmentClient(port, "token").run({ operation: "sync" }, "call-1", 20, controller.signal),
		).rejects.toThrow("已请求停止");
		expect(operations).toEqual(["start", "cancel"]);
	});
	it("registers tools only with a desktop capability and reports real failures", async () => {
		vi.stubEnv("KALO_INVESTMENT_TOKEN", "");
		const tools = new Map<string, ToolDefinition>();
		const api = {
			registerTool: (tool: ToolDefinition) => {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;
		investmentExtension(api);
		expect(tools.size).toBe(0);
		const port = await fixture((input, socket) =>
			reply(
				input,
				socket,
				input.command.operation === "start"
					? { jobId: "job" }
					: { id: "job", status: "failed", phase: "失败", error: "资金数据不足", result: null },
			),
		);
		vi.stubEnv("KALO_INVESTMENT_PORT", String(port));
		vi.stubEnv("KALO_INVESTMENT_TOKEN", "test");
		vi.stubEnv("KALO_UNATTENDED", "");
		vi.stubEnv("KALO_TASK_ROLE", "");
		investmentExtension(api);
		expect(tools.size).toBe(9);
		await expect(
			tools.get("investment_sync")?.execute("call", {}, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("资金数据不足");
	});
	it("never turns a running timeout into a successful completed report", async () => {
		const port = await fixture((input, socket) =>
			reply(input, socket, { id: "job", status: "running", phase: "采集中", result: null }),
		);
		expect((await new InvestmentClient(port, "token").wait("job", 0)).status).toBe("running");
	});
	it("preserves read-only approval for mutations while allowing evidence queries", () => {
		for (const tool of [
			"investment_sync",
			"investment_backtest",
			"investment_market_sync",
			"investment_margin_sync",
			"investment_script_backtest",
			"investment_catalog",
			"investment_flows",
		]) {
			const decision = decide({
				mode: "read-only",
				tool,
				input: {},
				workspace: "/workspace",
				agentDir: "/agent",
				grants: [],
			});
			expect(decision.kind).toBe(tool.endsWith("sync") || tool.endsWith("backtest") ? "ask" : "allow");
		}
	});
});
