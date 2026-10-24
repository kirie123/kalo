/** Local NDJSON smoke test. Isolated home; no credentials, network feeds or model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "..");
const home = mkdtempSync(path.join(tmpdir(), "kalo-gateway-smoke-"));
const agentDir = path.join(home, ".kalo", "agent");
mkdirSync(agentDir, { recursive: true });
mkdirSync(path.join(home, ".kalo", "feeds"), { recursive: true });
writeFileSync(path.join(agentDir, "schedules.json"), '{"tasks":[]}\n');
const args = process.argv[2] ? [] : ["src/main.ts"];
const child = spawn(process.argv[2] || "bun", args, {
  cwd: path.join(root, "kalo-desktop/gateway"),
  env: { ...process.env, USERPROFILE: home, HOME: home }, windowsHide: true,
});
const messages = [];
let failure;
let seq = 0;
let diagnostic = "";
child.on("error", (error) => { failure = error; });
child.on("exit", (code) => { if (code) failure = new Error(`gateway exited: ${code}`); });
child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); });
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => { try { messages.push(JSON.parse(line)); } catch { failure = new Error("non-JSON stdout: " + line); } });
async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("gateway response timed out");
}
function send(value) { child.stdin.write(JSON.stringify(value) + "\n"); }
async function command(value) {
  const requestId = `smoke-${++seq}`;
  send({ ...value, requestId });
  return until(() => messages.find((message) => message.type === "schedule_reply" && message.requestId === requestId));
}
try {
  await until(() => messages.some((message) => message.type === "schedule_status"));
  const task = { id: "smoke", name: "隔离测试", kind: "watch", cwd: home, script: "echo local-smoke", schedule: "* * * * *", cooldownMin: 60, enabled: false };
  assert.equal((await command({ cmd: "schedule_upsert", task: { ...task, schedule: "invalid" } })).ok, false);
  assert.equal((await command({ cmd: "schedule_upsert", task })).ok, true);
  for (let iteration = 0; iteration < 2; iteration++) {
    const start = messages.length;
    assert.equal((await command({ cmd: "schedule_run", id: task.id })).ok, true);
    await until(() => messages.slice(start).find((message) => message.type === "schedule_status" && message.tasks.some((entry) => entry.id === task.id && entry.lastOutput === "local-smoke" && !entry.running)));
  }
  const persisted = JSON.parse(readFileSync(path.join(agentDir, "schedules.json"), "utf8"));
  assert.equal(persisted.tasks[0].lastOutput, "local-smoke");
  assert.equal((await command({ cmd: "schedule_remove", id: task.id })).ok, true);
  assert.equal((await command({ cmd: "schedule_run", id: task.id })).ok, false);
  const agent = { ...task, id: "agent-smoke", kind: "agent", prompt: "no model call", script: undefined };
  assert.equal((await command({ cmd: "schedule_upsert", task: agent })).ok, true);
  assert.equal((await command({ cmd: "schedule_run", id: agent.id })).ok, true);
  const request = await until(() => messages.find((message) => message.type === "session_request"));
  send({ cmd: "session_started", taskId: request.taskId, sessionId: "fake-session" });
  send({ cmd: "event", sessionId: "fake-session", cwd: home, payload: { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] } });
  send({ cmd: "event", sessionId: "fake-session", cwd: home, payload: { type: "agent_settled" } });
  await until(() => messages.find((message) => message.type === "session_close" && message.sessionId === "fake-session"));
  await command({ cmd: "schedule_remove", id: agent.id });
  console.log("Gateway smoke passed: validation, persisted writes, manual rerun during cooldown, removal and RPC settlement.");
} catch (error) { console.error(diagnostic); throw error; }
finally {
  child.stdin.end();
  if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill();
  lines.close();
  // This is the unique absolute temp directory created by this script.
  if (!home.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("unexpected smoke directory");
  rmSync(home, { recursive: true, force: true });
}
