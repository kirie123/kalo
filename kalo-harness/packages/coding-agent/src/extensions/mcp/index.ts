/**
 * MCP (Model Context Protocol) client extension — P1-A of the personal
 * agent roadmap (doc/kalo-personal-agent-roadmap.md §6.1).
 *
 * Spawns configured MCP servers over stdio, handshakes them, and exposes
 * every server tool as a kalo tool named `mcp_<server>_<tool>`. Servers are
 * declared in ~/.kalo/agent/mcp.json:
 *
 *   { "servers": { akshare: { "command": "uvx", "args": ["akshare-mcp"], "env": {...} } } }
 *
 * No SDK dependency: MCP stdio transport is newline-delimited JSON-RPC 2.0,
 * and we only need initialize / tools/list / tools/call.
 *
 * The handshake result (tools or error per server) is mirrored to
 * ~/.kalo/agent/mcp-status.json so the desktop settings page can render the
 * tool inventory without talking to the engine.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { AgentToolResult, ExtensionAPI } from "../../core/extensions/types.ts";

// ---------------------------------------------------------------------------
// Config & status files
// ---------------------------------------------------------------------------

interface McpServerDef {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	enabled?: boolean;
}

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface McpServerStatus {
	ok: boolean;
	tools: McpToolInfo[];
	error?: string;
}

function agentDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

function loadConfig(): Record<string, McpServerDef> {
	try {
		const data = JSON.parse(readFileSync(join(agentDir(), "mcp.json"), "utf-8"));
		const servers = (data as { servers?: unknown }).servers;
		if (!servers || typeof servers !== "object") return {};
		return servers as Record<string, McpServerDef>;
	} catch {
		// Missing/corrupt file = no servers configured.
		return {};
	}
}

function writeStatus(status: Record<string, McpServerStatus>): void {
	try {
		const file = join(agentDir(), "mcp-status.json");
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ servers: status, updatedAt: new Date().toISOString() }, null, 2));
		renameSync(tmp, file);
	} catch {
		// Status is best-effort diagnostics for the settings page.
	}
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (ndjson JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";
const HANDSHAKE_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { message?: string };
}

export class McpStdioClient {
	private child: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private buffer = "";
	private dead: string | null = null;
	private readonly name: string;
	private readonly def: McpServerDef;

	constructor(name: string, def: McpServerDef) {
		this.name = name;
		this.def = def;
		this.serverLabel = name;
	}

	/** Spawn the server process and complete the MCP handshake. */
	async connect(): Promise<void> {
		const child = spawn(this.def.command, this.def.args ?? [], {
			env: { ...process.env, ...(this.def.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;

		const die = (reason: string) => {
			this.dead = reason;
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error(`MCP server "${this.name}" ${reason}`));
			}
			this.pending.clear();
		};
		child.on("error", (err) => die(`failed to start: ${err.message}`));
		child.on("exit", (code) => {
			if (!this.dead) die(`exited early (code ${code ?? "null"})`);
		});

		let stderrTail = "";
		child.stderr?.setEncoding("utf-8");
		child.stderr?.on("data", (c: string) => {
			if (stderrTail.length < 2000) stderrTail += c;
		});

		child.stdout?.setEncoding("utf-8");
		let connected = false;
		child.stdout?.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl = this.buffer.indexOf("\n");
			while (nl >= 0) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line) this.handleLine(line);
				nl = this.buffer.indexOf("\n");
			}
			if (!connected) connected = true;
		});

		try {
			const init = (await this.request(
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "kalo", version: "1.0.0" },
				},
				HANDSHAKE_TIMEOUT_MS,
				stderrTail ? () => stderrTail : undefined,
			)) as { serverInfo?: { name?: string; version?: string } };
			this.notify("notifications/initialized", {});
			this.serverLabel =
				init?.serverInfo?.name && init.serverInfo.name !== this.name
					? `${this.name} (${init.serverInfo.name})`
					: this.name;
		} catch (err) {
			this.kill();
			throw err;
		}
	}

	private serverLabel: string;

	get label(): string {
		return this.serverLabel;
	}

	private handleLine(line: string): void {
		let msg: JsonRpcResponse;
		try {
			msg = JSON.parse(line) as JsonRpcResponse;
		} catch {
			return;
		}
		if (typeof msg.id !== "number") return; // server notifications are ignored
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if (msg.error) p.reject(new Error(msg.error.message ?? "unknown JSON-RPC error"));
		else p.resolve(msg.result);
	}

	private request(method: string, params: unknown, timeoutMs: number, diag?: () => string): Promise<unknown> {
		if (this.dead) {
			const extra = diag?.() ? `；stderr: ${diag()!.slice(-400)}` : "";
			return Promise.reject(new Error(`MCP server "${this.name}" unavailable (${this.dead})${extra}`));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const extra = diag?.() ? `；stderr: ${diag()!.slice(-400)}` : "";
				reject(new Error(`MCP "${this.name}" ${method} timed out after ${timeoutMs / 1000}s${extra}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(msg: unknown): void {
		if (!this.child?.stdin?.writable) return;
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	async listTools(): Promise<McpToolInfo[]> {
		const result = (await this.request("tools/list", {}, HANDSHAKE_TIMEOUT_MS)) as {
			tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
		};
		return (result.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<McpCallResult> {
		const base = this.request("tools/call", { name: toolName, arguments: args }, CALL_TIMEOUT_MS) as Promise<{
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			isError?: boolean;
		}>;
		const onAbort = () => this.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await base;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	kill(): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error(`MCP server "${this.name}" was shut down`));
		}
		this.pending.clear();
		try {
			this.child?.stdin?.end();
		} catch {}
		this.child?.kill();
		this.child = null;
	}
}

type McpCallResult = {
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
};

/** Map an MCP tool content array onto kalo tool result blocks. */
function mcpContentToBlocks(result: McpCallResult): {
	blocks: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
	text: string;
} {
	const blocks: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }> = [];
	const texts: string[] = [];
	for (const item of result.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") {
			blocks.push({ type: "text", text: item.text });
			texts.push(item.text);
		} else if (item.type === "image" && typeof item.data === "string") {
			blocks.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
			texts.push("[image]");
		}
	}
	if (blocks.length === 0) texts.push("(MCP server returned no content)");
	return { blocks, text: texts.join("\n") };
}

/** Tool names must stay within [a-zA-Z0-9_-]. */
function sanitizeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const clients: McpStdioClient[] = [];

process.on("exit", () => {
	for (const c of clients) c.kill();
});

export default function mcpExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const enabled = Object.entries(config).filter(([, def]) => {
		if (!def || typeof def.command !== "string" || !def.command.trim()) return false;
		return def.enabled !== false;
	});

	if (enabled.length === 0) return;

	// One shared init: spawn + handshake + tools/list for every server in
	// parallel; failures degrade to a status entry, never a session error.
	const ready = Promise.allSettled(
		enabled.map(async ([name, def]) => {
			const client = new McpStdioClient(name, def);
			try {
				await client.connect();
				clients.push(client);
				const tools = await client.listTools();
				return { name, tools, client } as const;
			} catch (err) {
				client.kill();
				throw Object.assign(new Error(String(err instanceof Error ? err.message : err)), { serverName: name });
			}
		}),
	);

	let registered = false;
	const registerTools = async (): Promise<void> => {
		if (registered) return;
		registered = true;
		const settled = await ready;
		const status: Record<string, McpServerStatus> = {};
		for (const r of settled) {
			const name =
				r.status === "fulfilled" ? r.value.name : ((r.reason as { serverName?: string })?.serverName ?? "unknown");
			if (r.status === "fulfilled") {
				status[name] = {
					ok: true,
					tools: r.value.tools.map(({ name: t, description }) => ({ name: t, description })),
				};
				for (const tool of r.value.tools) {
					registerOneTool(pi, name, r.value.client, tool.name, tool.description, tool.inputSchema);
				}
			} else {
				status[name] = { ok: false, tools: [], error: String((r.reason as Error)?.message ?? r.reason) };
			}
		}
		writeStatus(status);
	};

	// Tools must exist before the first agent run sees the tool list.
	pi.on("before_agent_start", async () => {
		await registerTools();
	});
}

function registerOneTool(
	pi: ExtensionAPI,
	serverName: string,
	client: McpStdioClient,
	toolName: string,
	description: string | undefined,
	inputSchema: Record<string, unknown> | undefined,
): void {
	const kaloName = `mcp_${sanitizeName(serverName)}_${sanitizeName(toolName)}`;
	const desc = `${description?.trim() || `Tool "${toolName}" from MCP server "${serverName}".`} (MCP server: ${serverName})`;

	// Prefer the server's own JSON Schema. TypeBox validates plain JSON
	// Schema objects; schemas with $ref/$defs (unsupported by TypeBox) fall
	// back to a permissive object so calls still go through.
	const props = inputSchema?.properties;
	const propsOk = props == null || (typeof props === "object" && !("$ref" in props));
	const schemaUsable =
		inputSchema &&
		typeof inputSchema === "object" &&
		inputSchema.type === "object" &&
		!("$ref" in inputSchema) &&
		!("$defs" in inputSchema) &&
		propsOk;
	const parameters = (schemaUsable ? inputSchema : Type.Object({}, { additionalProperties: true })) as TSchema;

	pi.registerTool({
		name: kaloName,
		label: `${serverName} · ${toolName}`,
		description: desc,
		promptSnippet: `${kaloName} — MCP ${serverName}/${toolName}`,
		parameters,
		// Arguments pass through verbatim; the server validates its own schema.
		prepareArguments: (args) => (args && typeof args === "object" ? args : {}) as never,
		async execute(
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<{ server: string; tool: string; isError?: boolean; error?: string }>> {
			try {
				const result = await client.callTool(toolName, params as Record<string, unknown>, signal);
				const { blocks, text } = mcpContentToBlocks(result);
				if (result.isError) {
					return {
						content: [{ type: "text", text: `MCP tool ${serverName}/${toolName} 返回错误：\n${text}` }],
						details: { server: serverName, tool: toolName, isError: true },
					};
				}
				return {
					content: blocks.map((b) =>
						b.type === "text"
							? { type: "text" as const, text: b.text ?? "" }
							: { type: "image" as const, data: b.data ?? "", mimeType: b.mimeType ?? "image/png" },
					),
					details: { server: serverName, tool: toolName },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `MCP 工具调用失败(${serverName}/${toolName}):${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { server: serverName, tool: toolName, error: String(err) },
				};
			}
		},
	});
}
