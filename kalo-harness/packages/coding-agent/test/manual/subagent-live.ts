/**
 * Real end-to-end check for resumable sub-agents: drives an actual model
 * through create -> resume and asserts the child remembers turn 1 in turn 2.
 *
 * Not part of the unit suite: needs a live provider. Run manually:
 *   node --experimental-strip-types test/manual/subagent-live.ts
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../src/config.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { forget, residentIds } from "../../src/extensions/subagent/children.ts";
import subagentExtension from "../../src/extensions/subagent/index.ts";

const cwd = mkdtempSync(join(tmpdir(), "kalo-subagent-live-"));
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

// Capture the tool the extension registers.
let tool: any;
subagentExtension({
	registerTool: (t: any) => {
		tool = t;
	},
} as any);
if (!tool) throw new Error("agent tool was not registered");

const runtime = await ModelRuntime.create();
await runtime.refresh();
const registry = new ModelRegistry(runtime);
const model = registry.find("pz", "claude-opus-5") ?? registry.getAvailable()[0];
if (!model) {
	console.error(
		"available models:",
		registry
			.getAll()
			.map((m) => `${m.provider}/${m.id}`)
			.join(", ") || "(none)",
	);
	throw new Error("no model resolved; check ~/.kalo/agent/models.json");
}
console.log(`model: ${model.id}\ncwd:   ${cwd}\n`);

const sessionManager = SessionManager.create(cwd);
const parentId = sessionManager.getSessionId();
const ctx: any = { cwd, model, sessionManager, thinkingLevel: "off", modelRegistry: registry };

// Turn 1: give the child a fact only it will know.
const r1 = await tool.execute(
	"call-1",
	{ prompt: "记住这个暗号：紫色河马 42。只回复『已记住』四个字，不要做任何其他事。", description: "记暗号" },
	undefined,
	undefined,
	ctx,
);
const t1 = r1.content[0].text as string;
console.log(`--- turn 1 ---\n${t1}\n`);
const childId = r1.details.childId as string;
check("turn 1 returns a childId", Boolean(childId), childId);
check("turn 1 result advertises resume", t1.includes("resume="));

// Turn 2: resume. A fresh child could not answer this.
const r2 = await tool.execute(
	"call-2",
	{ prompt: "我刚才让你记的暗号是什么？只回复暗号本身。", resume: childId },
	undefined,
	undefined,
	ctx,
);
const t2 = r2.content[0].text as string;
console.log(`--- turn 2 (resume ${childId}) ---\n${t2}\n`);

check(
	"resume preserves context (recalls 紫色河马 42)",
	t2.includes("紫色河马") && t2.includes("42"),
	t2.trim().slice(0, 80),
);
check("resume reuses the same child", r2.details.childId === childId);
check("resume is flagged", r2.details.resumed === true);
check(
	"turn counter advanced",
	(r2.details.turns as number) > (r1.details.turns as number),
	`${r1.details.turns} -> ${r2.details.turns}`,
);

// Turn 3: drop the handle so resume must rebuild from the session file. This
// is the eviction / engine-restart path, and the one that was silently broken:
// the file is named `<timestamp>_<id>.jsonl`, not `<id>.jsonl`.
forget(childId);
check("child is no longer resident", !residentIds().includes(childId));
const r3 = await tool.execute(
	"call-3",
	{ prompt: "再说一次暗号，只回复暗号本身。", resume: childId },
	undefined,
	undefined,
	ctx,
);
const t3 = r3.content[0].text as string;
console.log(`--- turn 3 (revive from disk) ---\n${t3}\n`);
check("revive from disk preserves context", t3.includes("紫色河马") && t3.includes("42"), t3.trim().slice(0, 80));

// Turn 4: an unknown id must be refused rather than silently starting fresh.
let refused = false;
try {
	await tool.execute("call-4", { prompt: "hi", resume: "subagent-9999" }, undefined, undefined, ctx);
} catch (e) {
	refused = String(e).includes("未知子 agent");
}
check("unknown resume id is refused", refused);

// Storage: child files must sit in the nested bucket, not the parent's list.
const bucketRoot = join(getAgentDir(), "sessions");
const buckets = readdirSync(bucketRoot).filter((b) => b.includes("kalo-subagent-live"));
let sessionFile = "";
let transcript = "";
for (const b of buckets) {
	const dir = join(bucketRoot, b, "subagent", parentId);
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".jsonl")) sessionFile = join(dir, f);
			if (f.endsWith(".md")) transcript = join(dir, f);
		}
	}
}
check("child session persisted under subagent/<parent>/", Boolean(sessionFile), sessionFile);
check("transcript persisted beside it", Boolean(transcript), transcript);

if (transcript) {
	const md = readFileSync(transcript, "utf8");
	check(
		"transcript has all three turns appended",
		md.includes("## 第 1 轮") && md.includes("## 第 2 轮") && md.includes("## 第 3 轮"),
	);
	check("transcript header written once", (md.match(/# 子 agent 转录/g) || []).length === 1);
}

// The top-level bucket must contain only the parent conversation. The parent
// session file appears only once it has entries, so an empty bucket is fine —
// what must never happen is a child surfacing here.
for (const b of buckets) {
	const top = readdirSync(join(bucketRoot, b)).filter((f) => f.endsWith(".jsonl"));
	check(
		"no child session leaked into the parent bucket",
		top.every((f) => !f.includes("subagent-")),
		top.join(", ") || "(empty)",
	);
}

rmSync(cwd, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
