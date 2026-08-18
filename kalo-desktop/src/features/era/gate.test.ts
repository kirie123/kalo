import { describe, expect, it } from "vitest";
import { parseScoreLine, runGateChecks, scriptsInCommand, type EvalProbe, type GateInput } from "./gate";
import { SPEC_DEFAULTS, type EraRunSpec } from "./spec";

function spec(over: Partial<EraRunSpec> = {}): EraRunSpec {
  return {
    version: 1,
    name: "run",
    task: "拟合",
    seed: "seed",
    evalCmd: "python eval.py",
    metricGoal: "max",
    budget: 20,
    evalTimeout: 300,
    mutateTimeout: SPEC_DEFAULTS.mutateTimeout,
    maxSteps: 20,
    evalRepeats: 1,
    evalAggregate: "mean",
    bestBy: "mean",
    lcbZ: 1,
    cPuct: 1,
    holdoutEval: null,
    holdoutWhen: "best",
    recombineEvery: 4,
    ideas: null,
    extraInstruction: "",
    evolves: ["solution.py"],
    scoreMeaning: "",
    eraBin: null,
    ...over,
  };
}

function probe(over: Partial<EvalProbe> = {}): EvalProbe {
  return {
    stdout: "points=21 SSE=32900\n-32900.000000\n",
    stderr: "",
    exitCode: 0,
    durationS: 0.4,
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    spec: spec(),
    first: probe(),
    second: probe(),
    fixtures: ["eval.py"],
    fixturesPresent: true,
    ...over,
  };
}

const byId = (r: ReturnType<typeof runGateChecks>, id: string) =>
  r.checks.find((c) => c.id === id)!;

describe("parseScoreLine", () => {
  it("takes the last non-empty line, matching era/evaluate.py", () => {
    expect(parseScoreLine("diagnostics\n-32900.5\n")).toBe(-32900.5);
    expect(parseScoreLine("-1\n\n\n")).toBe(-1);
  });

  it("is not fooled by a number earlier in the output", () => {
    expect(parseScoreLine("score=5\nall done\n")).toBeNull();
  });

  it("rejects NaN and Infinity spellings that Number() would accept", () => {
    // Number("Infinity") is Infinity, which is not a usable score.
    expect(parseScoreLine("Infinity\n")).toBeNull();
    expect(parseScoreLine("NaN\n")).toBeNull();
  });

  it("answers null for no output at all", () => {
    expect(parseScoreLine("")).toBeNull();
  });
});

describe("scriptsInCommand", () => {
  it("finds the scorer path and ignores the interpreter and flags", () => {
    expect(scriptsInCommand("python eval.py")).toEqual(["eval.py"]);
    expect(scriptsInCommand("python -m pytest tests/score.py")).toEqual(["tests/score.py"]);
    expect(scriptsInCommand("bash run.sh --fast")).toEqual(["run.sh"]);
  });
});

describe("gate checks", () => {
  it("passes a clean seed and allows starting", () => {
    const r = runGateChecks(input());
    expect(r.baseline).toBe(-32900);
    expect(r.canStart).toBe(true);
    for (const c of r.checks) expect(c.status).toBe("pass");
  });

  it("blocks starting when the last line is not a number", () => {
    const r = runGateChecks(input({ first: probe({ stdout: "all tests passed\n" }) }));
    expect(r.canStart).toBe(false);
    expect(byId(r, "score_parses").status).toBe("fail");
  });

  it("warns but does not block on a non-zero exit code", () => {
    const r = runGateChecks(input({ first: probe({ exitCode: 1 }) }));
    expect(byId(r, "exit_code").status).toBe("warn");
    expect(r.canStart).toBe(true);
  });

  it("catches a noisy eval by comparing two runs", () => {
    const r = runGateChecks(input({ second: probe({ stdout: "-32901.0\n" }) }));
    const c = byId(r, "deterministic");
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("--eval-repeats");
  });

  it("reports unknown when only one run was made", () => {
    const r = runGateChecks(input({ second: undefined }));
    expect(byId(r, "deterministic").status).toBe("unknown");
  });

  it("warns when the scorer is not protected — the reward-hacking hole", () => {
    const r = runGateChecks(input({ fixtures: [], fixturesPresent: true }));
    const c = byId(r, "scorer_protected");
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("刷分");
  });

  it("warns when there is no fixtures manifest at all", () => {
    const r = runGateChecks(input({ fixtures: [], fixturesPresent: false }));
    expect(byId(r, "scorer_protected").status).toBe("warn");
  });

  it("fails when the file meant to evolve is frozen by the manifest", () => {
    const r = runGateChecks(input({ fixtures: ["eval.py", "solution.py"] }));
    const c = byId(r, "target_not_protected");
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("改了等于没改");
  });

  it("cannot judge the evolve target when the spec omits it", () => {
    const r = runGateChecks(input({ spec: spec({ evolves: [] }) }));
    expect(byId(r, "target_not_protected").status).toBe("unknown");
  });

  it("warns when the eval is already close to its own timeout", () => {
    const r = runGateChecks(input({ first: probe({ durationS: 200 }) }));
    expect(byId(r, "timeout_headroom").status).toBe("warn");
  });

  it("reports a launch failure as a failed score check, not a crash", () => {
    const r = runGateChecks(
      input({ first: probe({ stdout: "", launchError: "bash: python: command not found" }) }),
    );
    expect(r.canStart).toBe(false);
    expect(byId(r, "score_parses").detail).toContain("command not found");
    expect(byId(r, "exit_code").status).toBe("fail");
  });

  it("notes an oversized seed, since every node copies it", () => {
    const r = runGateChecks(input({ seedBytes: 900 * 1024 * 1024 }));
    expect(r.notes.join()).toContain("MB");
  });
});
