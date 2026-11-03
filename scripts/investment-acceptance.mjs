// Invoked by the debug desktop's --investment-acceptance mode in an isolated KALO_HOME.
// Calls the real registered extension tools against the production Rust task service.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import investmentExtension from "../kalo-harness/packages/coding-agent/src/extensions/investment/index.ts";
import { InvestmentClient } from "../kalo-harness/packages/coding-agent/src/extensions/investment/client.ts";
import { runFauxAgent } from "./investment-faux-agent.mjs";

assert.equal(process.env.KALO_INVESTMENT_ACCEPTANCE, "1");
const tools = new Map();
investmentExtension({ registerTool: (tool) => tools.set(tool.name, tool) });
assert.equal(tools.size, 6);
const invoke = async (name, params, id = crypto.randomUUID(), signal) => {
  const result = await tools.get(name).execute(id, params, signal, undefined, {});
  return result.details.result;
};
const client = new InvestmentClient(Number(process.env.KALO_INVESTMENT_PORT), process.env.KALO_INVESTMENT_TOKEN);
const other = new InvestmentClient(Number(process.env.KALO_INVESTMENT_PORT_SECOND), process.env.KALO_INVESTMENT_TOKEN_SECOND);
const root = join(process.env.KALO_HOME, "investment");
const catalog = await invoke("investment_catalog", {});
assert.ok(Array.isArray(catalog.snapshots));
const syncId = crypto.randomUUID();
const synced = await invoke("investment_sync", {}, syncId);
assert.equal(synced.status, "completed");
const repeated = await client.request({ operation: "start", request: { operation: "sync" } }, syncId);
assert.equal(repeated.jobId, synced.id);
await assert.rejects(other.request({ operation: "status", jobId: synced.id }), /任务不存在/);
await assert.rejects(other.request({ operation: "cancel", jobId: synced.id }), /任务不存在/);
const flows = await invoke("investment_flows", { snapshotId: synced.result.id, days: 5 });
assert.equal(flows.rows.length, 3);
assert.equal(flows.snapshotId, synced.result.id);
const spec = synced.result.defaultSpec;
assert.ok(spec && spec.snapshotId === synced.result.id);
await assert.rejects(client.request({ operation: "start", request: { operation: "backtest", spec } }, syncId), /不同参数/);
const run = await invoke("investment_backtest", { spec });
assert.equal(run.status, "completed");
const saved = JSON.parse(readFileSync(join(root, "reports", `${run.result.id}.json`), "utf8"));
assert.equal(saved.id, run.result.id);
assert.equal(saved.totalReturn, run.result.totalReturn);
assert.equal(saved.equity.length, 60);
assert.equal(saved.snapshotHash.length, 64);
const before = readdirSync(join(root, "reports")).length;
await assert.rejects(invoke("investment_backtest", { spec: { ...spec, flowFilter: true } }), /资金数据/);
assert.equal(readdirSync(join(root, "reports")).length, before);
const started = await client.request({ operation: "start", request: { operation: "sync" } });
await assert.rejects(other.request({ operation: "start", request: { operation: "sync" } }), /已有投行任务/);
await invoke("investment_cancel", { jobId: started.jobId });
assert.equal((await invoke("investment_status", { jobId: started.jobId })).status, "cancelled");
assert.equal(readdirSync(join(root, "reports")).length, before);
// Finish at a real successful report so the persisted activity can drive the panel acceptance.
const final = await invoke("investment_backtest", { spec });
const agentLoop = await runFauxAgent();
writeFileSync(join(root, "acceptance-evidence.json"), JSON.stringify({
  ok: true, tools: [...tools.keys()], snapshot: synced.result, flows,
  report: final.result, agentLoop, idempotency: true, ownerIsolation: true, sharedSlot: true, cancellation: true,
  mode: "registered-extension-to-native-rust-service; no paid model",
}, null, 2));
console.log(`PASS investment tools → native Rust service: snapshot ${synced.result.id}, report ${final.result.id}, ${saved.equity.length} daily equity records; ownership, replay and cancellation verified.`);
