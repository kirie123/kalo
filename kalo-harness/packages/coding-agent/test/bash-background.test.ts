/**
 * bash 后台模式（doc/2026-09-24-bash-后台模式.md）：run_in_background 不再本地
 * spawn，而是把命令交给 job runtime，立即返回 job id。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type BashToolInput, createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	type BackgroundCommandRequest,
	commandLabel,
	startBackgroundCommand,
} from "../src/extensions/kalo-jobs/background.ts";

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: any;
}

/** Captures the HTTP calls a starter would make, without a real gateway. */
function gatewayStub(reply: unknown) {
	const calls: Call[] = [];
	const fetchImpl = (async (url: any, init: any) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: init?.body ? JSON.parse(init.body) : undefined,
		});
		return new Response(JSON.stringify(reply), { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "kalo-bash-background-test-"));
	return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function textOf(result: { content: unknown }): string {
	return (result.content as Array<{ type: string; text?: string }>)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** A fake session context: the tool only reads session id/file and the model. */
function sessionContext(id: string): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
}

describe("commandLabel", () => {
	it("uses the first non-empty line and bounds its length", () => {
		expect(commandLabel("sleep 5")).toBe("sleep 5");
		expect(commandLabel("\n  \npnpm build\n")).toBe("pnpm build");
		const long = "x".repeat(300);
		expect(commandLabel(long)).toHaveLength(120);
		expect(commandLabel(long).endsWith("…")).toBe(true);
	});
});

describe("startBackgroundCommand", () => {
	it("posts kind/label/cwd/cmd/env with the owning session", async () => {
		await withTempDir(async (dir) => {
			const file = join(dir, "endpoint.json");
			writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:9999", token: "tok", pid: 1 }));
			const { calls, fetchImpl } = gatewayStub({ id: "bash-7", job: { id: "bash-7" } });

			const started = await startBackgroundCommand(
				{ command: "pnpm build", cwd: dir, env: { PATH: "/usr/bin", DROPPED: undefined }, owner: "s-1" },
				{ file, fetchImpl },
			);

			expect(started.id).toBe("bash-7");
			expect(calls[0].url).toBe("http://127.0.0.1:9999/jobs");
			expect(calls[0].method).toBe("POST");
			expect(calls[0].headers["x-kalo-session"]).toBe("s-1");
			expect(calls[0].body).toEqual({
				kind: "bash",
				label: "pnpm build",
				cwd: dir,
				cmd: "pnpm build",
				env: { PATH: "/usr/bin" },
			});
		});
	});

	it("reports a missing gateway instead of falling back to a local process", async () => {
		await withTempDir(async (dir) => {
			await expect(
				startBackgroundCommand({ command: "pnpm build", cwd: dir, env: {} }, { file: join(dir, "endpoint.json") }),
			).rejects.toThrow("网关未运行");
		});
	});

	it("rejects a working directory that no longer exists", async () => {
		await expect(
			startBackgroundCommand({ command: "pwd", cwd: join(tmpdir(), "kalo-missing-dir-for-test"), env: {} }),
		).rejects.toThrow("Working directory does not exist");
	});
});

describe("bash run_in_background", () => {
	it("hands the composed command to the starter and returns the job id", async () => {
		const requests: BackgroundCommandRequest[] = [];
		const definition = createBashToolDefinition(process.cwd(), {
			commandPrefix: "export CI=1",
			backgroundStarter: async (request) => {
				requests.push(request);
				return { id: "bash-9" };
			},
		});

		const result = await definition.execute(
			"call-1",
			{ command: "pnpm build", run_in_background: true },
			undefined,
			undefined,
			sessionContext("s-9"),
		);

		expect(requests).toHaveLength(1);
		expect(requests[0].command).toBe("export CI=1\npnpm build");
		expect(requests[0].cwd).toBe(process.cwd());
		expect(requests[0].owner).toBe("s-9");
		expect(textOf(result)).toContain("bash-9");
		expect(textOf(result)).toContain("job_output");
	});

	it.each([undefined, null, 0])("accepts background timeout %s as no time limit", async (timeout) => {
		const requests: BackgroundCommandRequest[] = [];
		const definition = createBashToolDefinition(process.cwd(), {
			backgroundStarter: async (request) => {
				requests.push(request);
				return { id: "bash-unlimited" };
			},
		});

		// Exercise the runtime guard directly, including null before argument normalization.
		const args = { command: "pnpm build", timeout, run_in_background: true } as unknown as BashToolInput;
		const result = await definition.execute("call-1", args, undefined, undefined, sessionContext("s-1"));

		expect(requests).toHaveLength(1);
		expect(requests[0].command).toBe("pnpm build");
		expect(textOf(result)).toContain("bash-unlimited");
	});

	it("accepts null timeout through validateToolArguments and starts the background job", async () => {
		const requests: BackgroundCommandRequest[] = [];
		const definition = createBashToolDefinition(process.cwd(), {
			backgroundStarter: async (request) => {
				requests.push(request);
				return { id: "bash-null" };
			},
		});
		const args: BashToolInput = validateToolArguments(definition, {
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: "pnpm build", timeout: null, run_in_background: true },
		});

		const result = await definition.execute("call-1", args, undefined, undefined, sessionContext("s-1"));

		expect(requests).toHaveLength(1);
		expect(requests[0].command).toBe("pnpm build");
		expect(textOf(result)).toContain("bash-null");
	});

	it.each([10, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects background timeout %s before starting a job",
		async (timeout) => {
			let called = false;
			const definition = createBashToolDefinition(process.cwd(), {
				backgroundStarter: async () => {
					called = true;
					return { id: "bash-1" };
				},
			});

			await expect(
				definition.execute(
					"call-1",
					{ command: "sleep 5", timeout, run_in_background: true },
					undefined,
					undefined,
					sessionContext("s-1"),
				),
			).rejects.toThrow("cannot be combined with timeout");
			expect(called).toBe(false);
		},
	);

	it.each([undefined, false])("rejects foreground timeout 0 with run_in_background=%s", async (run_in_background) => {
		const definition = createBashToolDefinition(process.cwd());
		const args: BashToolInput = validateToolArguments(definition, {
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: "echo test", timeout: 0, run_in_background },
		});

		await expect(definition.execute("call-1", args, undefined, undefined, sessionContext("s-1"))).rejects.toThrow(
			"Invalid timeout",
		);
	});

	it("is unavailable when the tool has custom operations", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: { exec: async () => ({ exitCode: 0 }) },
		});

		await expect(
			definition.execute(
				"call-1",
				{ command: "sleep 5", run_in_background: true },
				undefined,
				undefined,
				sessionContext("s-1"),
			),
		).rejects.toThrow("not available on this bash tool");
	});

	it("surfaces a starter failure as the tool error", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			backgroundStarter: async () => {
				throw new Error("后台模式不可用：Kalo 网关未运行");
			},
		});

		await expect(
			definition.execute(
				"call-1",
				{ command: "sleep 5", run_in_background: true },
				undefined,
				undefined,
				sessionContext("s-1"),
			),
		).rejects.toThrow("网关未运行");
	});

	it("advertises the background workflow in the prompt guidelines", () => {
		const definition = createBashToolDefinition(process.cwd());
		expect(definition.promptGuidelines?.some((line) => line.includes("run_in_background"))).toBe(true);
	});
});
