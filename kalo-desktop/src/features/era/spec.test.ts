import { describe, expect, it } from "vitest";
import { buildServeCommand, parseSpec, serializeSpec, shq, SPEC_DEFAULTS } from "./spec";

const MINIMAL = JSON.stringify({
  task: "把 solve(x) 拟合得更准",
  seed: "seed",
  eval: "python eval.py",
  budget: 8,
});

describe("parseSpec", () => {
  it("fills era's own defaults for everything omitted", () => {
    const r = parseSpec(MINIMAL);
    if (!r.ok) throw new Error(r.error);
    expect(r.spec.budget).toBe(8);
    expect(r.spec.metricGoal).toBe(SPEC_DEFAULTS.metricGoal);
    expect(r.spec.maxSteps).toBe(SPEC_DEFAULTS.maxSteps);
    expect(r.spec.cPuct).toBe(SPEC_DEFAULTS.cPuct);
    expect(r.spec.evolves).toEqual([]);
  });

  it("rejects an unknown field instead of ignoring it", () => {
    // A typo'd key that silently did nothing would cost a whole run.
    const r = parseSpec(JSON.stringify({ ...JSON.parse(MINIMAL), budgetted: 50 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("budgetted");
  });

  it("rejects a version it does not understand", () => {
    const r = parseSpec(JSON.stringify({ ...JSON.parse(MINIMAL), version: 2 }));
    expect(r.ok).toBe(false);
  });

  it("names the missing required field", () => {
    const r = parseSpec(JSON.stringify({ seed: "seed", eval: "python eval.py" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("task");
  });

  it("rejects a non-integer budget rather than truncating it", () => {
    const r = parseSpec(JSON.stringify({ ...JSON.parse(MINIMAL), budget: 3.5 }));
    expect(r.ok).toBe(false);
  });

  it("reports bad JSON as bad JSON", () => {
    const r = parseSpec("{ not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("JSON");
  });

  it("round-trips through serializeSpec", () => {
    const first = parseSpec(MINIMAL);
    if (!first.ok) throw new Error(first.error);
    const second = parseSpec(serializeSpec(first.spec));
    if (!second.ok) throw new Error(second.error);
    expect(second.spec).toEqual(first.spec);
  });
});

describe("shell quoting", () => {
  it("survives spaces, Chinese and single quotes", () => {
    expect(shq("D:/我的 项目/seed")).toBe("'D:/我的 项目/seed'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe("buildServeCommand", () => {
  const opts = {
    outDir: "D:/w/era-runs/r1",
    seedDir: "D:/w/seed",
    agentBin: "C:/Program Files/kalo/pi.exe",
  };

  it("always passes -q and --agent-bin", () => {
    const r = parseSpec(MINIMAL);
    if (!r.ok) throw new Error(r.error);
    const cmd = buildServeCommand(r.spec, opts);
    // -q keeps era's stderr chatter out of the job log, which is 2>&1.
    expect(cmd).toContain("era serve -q ");
    expect(cmd).toContain(`--agent-bin '${opts.agentBin}'`);
  });

  it("quotes every path-bearing argument", () => {
    const r = parseSpec(MINIMAL);
    if (!r.ok) throw new Error(r.error);
    const cmd = buildServeCommand(r.spec, opts);
    expect(cmd).toContain(`--seed '${opts.seedDir}'`);
    expect(cmd).toContain(`--out '${opts.outDir}'`);
    expect(cmd).toContain(`--eval 'python eval.py'`);
  });

  it("omits holdout flags entirely when no holdout eval is configured", () => {
    const r = parseSpec(MINIMAL);
    if (!r.ok) throw new Error(r.error);
    expect(buildServeCommand(r.spec, opts)).not.toContain("--holdout");
  });

  it("includes holdout flags when one is configured", () => {
    const r = parseSpec(JSON.stringify({ ...JSON.parse(MINIMAL), holdoutEval: "python holdout.py" }));
    if (!r.ok) throw new Error(r.error);
    const cmd = buildServeCommand(r.spec, opts);
    expect(cmd).toContain(`--holdout-eval 'python holdout.py'`);
    expect(cmd).toContain("--holdout-when best");
  });
});
