import { describe, expect, it } from "vitest";
import { EraFolder, bestNode } from "./fold";
import { parseSpec, serializeSpec, buildServeCommand } from "./spec";
import { parseAcceptanceResult } from "./acceptance";
import gradedServe from "./fixtures/graded-serve.jsonl?raw";

const contractId = "b".repeat(64);
const candidateHash = "a".repeat(64);
const required = [{ name: "regression", level: "full", checks: ["gradient"] }];
const artifact = { node_id: 1, path: "accepted", contract_id: contractId, candidate_hash: candidateHash };
const result = { status: "PASS", node_id: 1, contract_id: contractId, candidate_hash: candidateHash,
  stages: [{ stage: "regression", level: "full", status: "PASS", checks_completed: ["gradient"] }] };

describe("graded acceptance", () => {
  it("reads the captured offline era serve stream, including the final artifact", () => {
    const folder = new EraFolder();
    for (let offset = 0; offset < gradedServe.length; offset += 13) folder.push(gradedServe.slice(offset, offset + 13));
    const tree = folder.snapshot();
    const finished = JSON.parse(gradedServe.trim().split("\n").at(-1)!);
    expect(tree.finished).toBe(true);
    expect(tree.unparsedLines).toBe(0);
    expect(tree.acceptanceStatus).toBe("PASS");
    expect(tree.accepted?.candidateHash).toBe(finished.accepted.candidate_hash);
    expect(tree.acceptanceStages.filter((s) => s.scope === "final").map((s) => s.level)).toEqual(["quick", "full"]);
  });

  it("refuses missing frozen requirements or omitted checks", () => {
    expect(parseAcceptanceResult(result, artifact, contractId).accepted).toBeNull();
    expect(parseAcceptanceResult(result, artifact, contractId, [
      { name: "smoke", level: "quick", checks: ["finite"] }, ...required,
    ]).accepted).toBeNull();
    expect(parseAcceptanceResult(result, artifact, contractId, [
      { ...required[0], checks: ["gradient", "optimizer"] },
    ]).accepted).toBeNull();
  });

  it("requires a full check and a matching artifact, not just PASS", () => {
    expect(parseAcceptanceResult(result, artifact, contractId, required).accepted?.nodeId).toBe(1);
    for (const bad of [null, { ...artifact, path: "../elsewhere" }, { ...artifact, candidate_hash: "wrong" }]) {
      expect(parseAcceptanceResult(result, bad, contractId, required).status).toBe("INFRA_ERROR");
    }
    expect(parseAcceptanceResult({ ...result, stages: [] }, artifact, contractId, required).accepted).toBeNull();
    expect(parseAcceptanceResult({ ...result, stages: [{ ...result.stages[0], level: "quick" }] }, artifact, contractId, required).accepted).toBeNull();
  });

  it("folds fragmented real protocol records without promoting quick PASS", () => {
    const f = new EraFolder();
    const push = (r: object) => { const s = JSON.stringify(r) + "\n"; f.push(s.slice(0, 5)); f.push(s.slice(5)); };
    push({ kind: "contract_frozen", contract_id: contractId, name: "训练正确性", stages: required });
    push({ kind: "acceptance_stage", node_id: 1, scope: "screen", level: "quick", stage: "shape", status: "PASS" });
    expect(f.snapshot().accepted).toBeNull();
    expect(f.snapshot().acceptanceStatus).toBe("NOT_RUN");
    push({ kind: "acceptance_stage", node_id: 1, scope: "final", ...result.stages[0] });
    expect(f.snapshot().acceptanceStatus).toBe("RUNNING");
    push({ kind: "acceptance_finished", acceptance: result, accepted: artifact });
    expect(f.snapshot().accepted?.candidateHash).toBe(candidateHash);
    f.reset();
    expect(f.snapshot().accepted).toBeNull();
    expect(f.snapshot().acceptanceStatus).toBe("NOT_CONFIGURED");
  });

  it.each(["FAIL", "INCONCLUSIVE", "INFRA_ERROR", "NOT_RUN"])("never exports %s", (status) => {
    expect(parseAcceptanceResult({ ...result, status }, artifact, contractId, required).accepted).toBeNull();
  });

  it.each(["max", "min"])("LCB replay uses the same ordering for %s", (goal) => {
    const f = new EraFolder();
    const scores = goal === "max" ? [10, 9] : [0, 1];
    const ranked = goal === "max" ? [0, 8] : [10, 2];
    f.push(JSON.stringify({ kind: "run_started", config: { metric_goal: goal } }) + "\n");
    for (let id = 0; id < 2; id++) f.push(JSON.stringify({ kind: "evaluated", node_id: id, score: scores[id], selection_score: ranked[id], eval_ok: true }) + "\n");
    expect(bestNode(f.snapshot())?.id).toBe(1);
  });
});

describe("contract configuration", () => {
  it("round-trips and quotes paths for the existing cross-platform bash launcher", () => {
    const parsed = parseSpec(JSON.stringify({ task: "improve", seed: "seed", eval: "python eval.py", contract: "规则/a'b.json" }));
    if (!parsed.ok) throw new Error(parsed.error);
    const roundTrip = parseSpec(serializeSpec(parsed.spec));
    expect(roundTrip.ok && roundTrip.spec.contract).toBe("规则/a'b.json");
    const command = buildServeCommand(parsed.spec, { outDir: "out", seedDir: "seed", agentBin: "pi", contractPath: "D:/工作区/规则/a'b.json" });
    expect(command).toContain("--contract 'D:/工作区/规则/a'\\''b.json'");
  });
  it("rejects malformed contract fields and preserves legacy specs", () => {
    const minimal = { task: "improve", seed: "seed", eval: "python eval.py" };
    for (const contract of [3, "", "x\ny"]) expect(parseSpec(JSON.stringify({ ...minimal, contract })).ok).toBe(false);
    const old = parseSpec(JSON.stringify(minimal));
    expect(old.ok && old.spec.contract).toBeNull();
  });
});
