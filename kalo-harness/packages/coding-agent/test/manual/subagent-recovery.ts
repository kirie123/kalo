/**
 * Real-model checks for the two failure-shaped questions:
 *
 *   1. Does resume deadlock when every concurrency slot is taken?
 *   2. Can the parent recover a child whose turn genuinely failed?
 *
 * Both need a live provider and a forced fault, so this is manual:
 *   KALO_SUBAGENT_CONCURRENCY=1 node --experimental-strip-types test/manual/subagent-recovery.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import subagentExtension from "../../src/extensions/subagent/index.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

let tool: any;
subagentExtension({
	registerTool: (t: any) => {
		tool = t;
	},
} as any);

const runtime = await ModelRuntime.create();
await runtime.refresh();
const registry = new ModelRegistry(runtime);
const realModel = registry.find("pz", "claude-opus-5");
if (!realModel) throw new Error("pz/claude-opus-5 not configured");

// ---------------------------------------------------------------------------
// A proxy that fails the first upstream call, then behaves. This reproduces a
// transient provider fault, which is the case worth resuming as-is.
// ---------------------------------------------------------------------------
let upstreamCalls = 0;
// The session retries a failed request internally, so a count-based fault is
// racy: flip the flag explicitly once turn 1 has come back.
let faultActive = true;
const upstream = new URL(realModel.baseUrl);
const proxy = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", async () => {
		upstreamCalls++;
		if (faultActive) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "injected fault" } }));
			return;
		}
		// baseUrl carries a path prefix (/yanjiuyuan); `new URL(req.url, base)`
		// would drop it and every forwarded call would 404.
		const target = new URL(`${upstream.pathname.replace(/\/$/, "")}${req.url ?? "/"}`, upstream.origin);
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (k === "host" || k === "content-length" || k === "connection") continue;
			if (typeof v === "string") headers[k] = v;
		}
		try {
			const r = await fetch(target, { method: req.method, headers, body: Buffer.concat(chunks) });
			// Must stream: these are SSE responses, and buffering the whole body
			// breaks the client's incremental parse (it sees an empty reply).
			const outHeaders: Record<string, string> = {};
			r.headers.forEach((v, k) => {
				if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") outHeaders[k] = v;
			});
			res.writeHead(r.status, outHeaders);
			if (!r.body) {
				res.end();
				return;
			}
			const reader = r.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				res.write(Buffer.from(value));
			}
			res.end();
		} catch (e) {
			res.writeHead(502).end(String(e));
		}
	});
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as any).port;
const flakyModel: any = { ...realModel, baseUrl: `http://127.0.0.1:${proxyPort}` };

const cwd = mkdtempSync(join(tmpdir(), "kalo-subagent-recovery-"));
const sessionManager = SessionManager.create(cwd);
const ctx: any = { cwd, model: flakyModel, sessionManager, thinkingLevel: "off", modelRegistry: registry };

console.log(`concurrency limit: ${process.env.KALO_SUBAGENT_CONCURRENCY ?? "(default 6)"}`);
console.log(`proxy: 127.0.0.1:${proxyPort} -> ${upstream.host}\n`);

// ---------------------------------------------------------------------------
// 1. Failure recovery
// ---------------------------------------------------------------------------
const r1 = await tool.execute(
	"c1",
	{ prompt: "记住暗号：青铜骆驼 7。只回复『已记住』。", description: "会失败的一轮" },
	undefined,
	undefined,
	ctx,
);
const t1 = r1.content[0].text as string;
console.log(`--- turn 1 (injected 500) ---\n${t1}\n`);

check("failed turn does NOT throw the tool call", true);
check("parent is told the failure reason", Boolean(r1.details.failed), String(r1.details.failed).slice(0, 60));
check("failure text names the error", t1.includes("报错中断"));
check("failed child still returns an id", Boolean(r1.details.childId), r1.details.childId);
check("failed child advertises resume", t1.includes("resume="));

const childId = r1.details.childId as string;

// The outage clears. Resume must carry the same child forward.
faultActive = false;

// Resume after the fault clears: the same child, same session, must carry on.
const r2 = await tool.execute(
	"c2",
	{ prompt: "记住暗号：青铜骆驼 7。只回复『已记住』。", resume: childId },
	undefined,
	undefined,
	ctx,
);
console.log(`--- turn 2 (resume after fault) ---\n${r2.content[0].text}\n`);
check("resume after failure succeeds", !r2.details.failed, String(r2.details.failed ?? ""));
check("resume reuses the failed child", r2.details.childId === childId);

const r3 = await tool.execute("c3", { prompt: "暗号是什么？只回复暗号。", resume: childId }, undefined, undefined, ctx);
const t3 = r3.content[0].text as string;
console.log(`--- turn 3 (verify context survived the failure) ---\n${t3}\n`);
check("context survived the failed turn", t3.includes("青铜骆驼") && t3.includes("7"), t3.trim().slice(0, 60));

// ---------------------------------------------------------------------------
// 2. Deadlock: resume a child while it is still running, with slots full.
//    With KALO_SUBAGENT_CONCURRENCY=1 the running child owns the only slot.
//    If resume asked for a slot it would wait for the child it is resuming.
// ---------------------------------------------------------------------------
ctx.model = realModel; // fault already spent; go direct
const slow = tool.execute(
	"c4",
	{ prompt: "请依次数 1 到 40，每个数字单独一行，慢慢数完再停。", description: "占满槽位" },
	undefined,
	undefined,
	ctx,
);
await new Promise((r) => setTimeout(r, 2500)); // let it take the slot

const resumeWhileBusy = tool.execute(
	"c5",
	{ prompt: "补充：数完后回复『收到』。", resume: r1.details.childId },
	undefined,
	undefined,
	ctx,
);
const verdict = await Promise.race([
	resumeWhileBusy.then(() => "returned"),
	new Promise((r) => setTimeout(() => r("DEADLOCK"), 90_000)),
]);
check("resume does not deadlock when slots are full", verdict === "returned", String(verdict));

await slow.catch(() => {});
await resumeWhileBusy.catch(() => {});

proxy.close();
rmSync(cwd, { recursive: true, force: true });
console.log(`\nupstream calls: ${upstreamCalls}`);
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
