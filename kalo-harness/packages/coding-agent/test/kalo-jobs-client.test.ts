import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobsClient, JobsUnavailable, readEndpoint } from "../src/extensions/kalo-jobs/client.ts";

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: any;
}

function harness(opts: { endpoint?: boolean; reply?: (call: Call) => { status?: number; body: unknown } } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "kalo-jobs-client-test-"));
	const file = join(dir, "endpoint.json");
	if (opts.endpoint !== false) {
		writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:9999", token: "tok-1", pid: 42 }));
	}
	const calls: Call[] = [];
	const fetchImpl = (async (url: any, init: any) => {
		const call: Call = {
			url: String(url),
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: init?.body ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		const reply = opts.reply?.(call) ?? { body: {} };
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
	}) as unknown as typeof fetch;
	const client = new JobsClient({ file, session: () => "s-1", fetchImpl });
	return { dir, file, calls, client, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("kalo-jobs client", () => {
	test("reads the published descriptor and rejects a malformed one", () => {
		const h = harness();
		expect(readEndpoint(h.file)?.token).toBe("tok-1");
		writeFileSync(h.file, "{not json");
		expect(readEndpoint(h.file)).toBeNull();
		writeFileSync(h.file, JSON.stringify({ url: "http://x" }));
		expect(readEndpoint(h.file)).toBeNull();
		h.cleanup();
	});

	test("presents the bearer token and the session id", async () => {
		const h = harness({ reply: () => ({ body: { jobs: [] } }) });
		await h.client.list();
		expect(h.calls[0].url).toBe("http://127.0.0.1:9999/jobs");
		expect(h.calls[0].headers.authorization).toBe("Bearer tok-1");
		expect(h.calls[0].headers["x-kalo-session"]).toBe("s-1");
		h.cleanup();
	});

	test("without a gateway every call fails as unavailable", async () => {
		const h = harness({ endpoint: false });
		expect(h.client.available()).toBe(false);
		await expect(h.client.list()).rejects.toBeInstanceOf(JobsUnavailable);
		expect(h.calls).toHaveLength(0);
		h.cleanup();
	});

	test("re-reads the descriptor per call, so a gateway restart is transparent", async () => {
		const h = harness({ reply: () => ({ body: { jobs: [] } }) });
		await h.client.list();
		writeFileSync(h.file, JSON.stringify({ url: "http://127.0.0.1:10000", token: "tok-2", pid: 43 }));
		await h.client.list();
		expect(h.calls[1].url).toBe("http://127.0.0.1:10000/jobs");
		expect(h.calls[1].headers.authorization).toBe("Bearer tok-2");
		h.cleanup();
	});

	test("surfaces the gateway's error message verbatim", async () => {
		const h = harness({ reply: () => ({ status: 400, body: { error: "未知任务：gateway-9" } }) });
		await expect(h.client.get("gateway-9")).rejects.toThrow("未知任务：gateway-9");
		h.cleanup();
	});

	test("output sends wait/timeout and kill sends the reason", async () => {
		const h = harness({ reply: (c) => ({ body: c.url.endsWith("/output") ? { text: "x", job: {} } : { result: "requested", job: {} } }) });
		await h.client.output("gateway-1", { wait: true, timeoutMs: 1234 });
		expect(h.calls[0].method).toBe("POST");
		expect(h.calls[0].body).toEqual({ wait: true, timeoutMs: 1234 });

		await h.client.kill("gateway-1", "停止");
		expect(h.calls[1].url).toBe("http://127.0.0.1:9999/jobs/gateway-1/kill");
		expect(h.calls[1].body).toEqual({ reason: "停止" });
		h.cleanup();
	});

	test("claimCompletions posts to the claim route", async () => {
		const h = harness({ reply: () => ({ body: { jobs: [{ id: "gateway-2" }] } }) });
		const jobs = await h.client.claimCompletions();
		expect(h.calls[0].url).toBe("http://127.0.0.1:9999/completions/claim");
		expect(h.calls[0].method).toBe("POST");
		expect(jobs.map((j) => j.id)).toEqual(["gateway-2"]);
		h.cleanup();
	});
});
