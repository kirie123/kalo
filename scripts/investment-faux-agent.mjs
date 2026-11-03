// Deterministic local model transport for the investment acceptance, never a paid endpoint.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export async function runFauxAgent() {
  assert.equal(process.env.KALO_INVESTMENT_ACCEPTANCE, "1");
  const engine = process.env.KALO_INVESTMENT_ACCEPTANCE_ENGINE;
  assert.ok(engine, "desktop must resolve the staged engine");
  let step = 0, snapshot, finalReport;
  const calls = [];
  let failure;
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const toolNames = input.tools?.map((t) => t.function.name) ?? [];
      let name, args;
      if (toolNames.includes("investment_catalog")) {
        assert.ok(input.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("ETF")));
        const previous = input.messages.filter((m) => m.role === "tool").at(-1);
        const content = previous?.content;
        const text = typeof content === "string" ? content : content?.filter((c) => c.type === "text").map((c) => c.text).join("");
        const last = text ? JSON.parse(text) : null;
        if (step === 0) { name = "investment_catalog"; args = {}; }
        else if (step === 1) { assert.ok(Array.isArray(last.snapshots)); name = "investment_sync"; args = {}; }
        else if (step === 2) {
          assert.equal(last.status, "completed"); snapshot = last.result;
          name = "investment_flows"; args = { snapshotId: snapshot.id, days: 5 };
        } else if (step === 3) {
          assert.equal(last.snapshotId, snapshot.id); assert.equal(last.rows.length, 3);
          name = "investment_backtest"; args = { spec: snapshot.defaultSpec };
        } else if (step === 4) {
          assert.equal(last.status, "completed"); finalReport = last.result;
          assert.equal(finalReport.spec.snapshotId, snapshot.id);
        } else throw new Error("Unexpected extra agent turn");
        step++;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta, reason = null) => response.write(`data: ${JSON.stringify({ id: "acceptance-local", object: "chat.completion.chunk", created: 1, model: "investment-local", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
      if (name) {
        calls.push(name);
        send({ role: "assistant", tool_calls: [{ index: 0, id: `local-investment-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: finalReport ? `已同步数据、分析 ETF 资金并完成回测。报告 ${finalReport.id} 已呈现在投行面板。` : "ETF 研究验收" });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) { failure = error; response.writeHead(500); response.end("acceptance failure"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const home = process.env.KALO_HOME;
  const agent = join(home, "agent"); mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "investment-local": {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-no-paid-key",
    models: [{ id: "investment-local", name: "Investment local acceptance", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4000 }],
  } } }));
  let child;
  try {
    child = spawn(engine, ["--mode", "json", "--no-session", "--no-skills", "--permission-mode", "workspace-write", "--provider", "investment-local", "--model", "investment-local", "-p", "请同步 ETF 免费数据，分析最近 5 日资金，并按默认参数完成一次回测，把结果呈现在投行面板。"], {
      cwd: home, env: { ...process.env, KALO_UNATTENDED: "", KALO_TASK_ROLE: "" }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", error = "";
    child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { error += d; });
    const timeout = setTimeout(() => child.kill(), 120_000);
    const [code] = await once(child, "exit"); clearTimeout(timeout);
    writeFileSync(join(home, "investment", "acceptance-agent-events.jsonl"), output);
    if (failure) throw failure;
    assert.equal(code, 0, error);
    assert.deepEqual(calls, ["investment_catalog", "investment_sync", "investment_flows", "investment_backtest"]);
    assert.ok(finalReport?.id, `Agent did not complete: ${error} ${output.slice(-2000)}`);
    return { calls, reportId: finalReport.id, model: "deterministic localhost fixture; no paid model" };
  } finally {
    child?.kill(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
