import { describe, expect, it } from "vitest";
import { diagnose } from "./diagnose";
import { EraFolder } from "./fold";
import type { EraTree } from "./types";

function build(records: Array<Record<string, unknown>>): EraTree {
  const f = new EraFolder();
  f.push(records.map((r, i) => JSON.stringify({ seq: i, ts: 1_700_000_000 + i, ...r })).join("\n") + "\n");
  return f.snapshot();
}

/** A seed plus `n` children built by `make`. */
function run(n: number, make: (i: number) => Array<Record<string, unknown>>, seedScore = 10) {
  const recs: Array<Record<string, unknown>> = [
    { kind: "run_started", config: { budget: n, metric_goal: "max" } },
    { kind: "node_created", node_id: 0, parent_id: null },
    { kind: "evaluated", node_id: 0, score: seedScore, eval_ok: true },
  ];
  for (let i = 1; i <= n; i++) recs.push(...make(i));
  return build(recs);
}

const ids = (t: EraTree) => diagnose(t).map((d) => d.id);

describe("diagnose", () => {
  it("says nothing about a healthy run", () => {
    const t = run(6, (i) => [
      { kind: "node_created", node_id: i, parent_id: i - 1 },
      { kind: "mutation_finished", node_id: i, ok: true },
      { kind: "evaluated", node_id: i, score: 10 + i, eval_ok: true },
    ]);
    expect(ids(t)).toEqual([]);
  });

  it("flags repeated mutation failures", () => {
    const t = run(5, (i) => [
      { kind: "node_created", node_id: i, parent_id: 0 },
      { kind: "mutation_finished", node_id: i, ok: false, reason: "超时" },
    ]);
    expect(ids(t)).toContain("mutation_failed");
  });

  it("does not flag a single mutation failure among many successes", () => {
    const t = run(8, (i) => [
      { kind: "node_created", node_id: i, parent_id: 0 },
      { kind: "mutation_finished", node_id: i, ok: i !== 3 },
      ...(i === 3 ? [] : [{ kind: "evaluated", node_id: i, score: 10 + i, eval_ok: true }]),
    ]);
    expect(ids(t)).not.toContain("mutation_failed");
  });

  it("flags widespread eval failure and names timeouts when that is the reason", () => {
    const t = run(5, (i) => [
      { kind: "node_created", node_id: i, parent_id: 0 },
      { kind: "mutation_finished", node_id: i, ok: true },
      { kind: "evaluated", node_id: i, score: -1e9, eval_ok: false, reason: "timeout after 300s" },
    ]);
    const d = diagnose(t).find((x) => x.id === "eval_failed");
    expect(d?.detail).toContain("超时");
    expect(d?.hint).toContain("--eval-timeout");
  });

  it("flags a run where nothing beats the seed", () => {
    const t = run(6, (i) => [
      { kind: "node_created", node_id: i, parent_id: 0 },
      { kind: "mutation_finished", node_id: i, ok: true },
      { kind: "evaluated", node_id: i, score: 10 - i * 0.1, eval_ok: true },
    ]);
    const d = diagnose(t).find((x) => x.id === "no_progress");
    // The most valuable hint in the whole panel: it points at the fixtures trap.
    expect(d?.hint).toContain(".era-fixtures");
  });

  it("stays quiet before there is enough evidence to say nothing improved", () => {
    const t = run(2, (i) => [
      { kind: "node_created", node_id: i, parent_id: 0 },
      { kind: "mutation_finished", node_id: i, ok: true },
      { kind: "evaluated", node_id: i, score: 9, eval_ok: true },
    ]);
    expect(ids(t)).not.toContain("no_progress");
  });

  it("respects a min goal when deciding what counts as better", () => {
    const recs: Array<Record<string, unknown>> = [
      { kind: "run_started", config: { budget: 6, metric_goal: "min" } },
      { kind: "node_created", node_id: 0, parent_id: null },
      { kind: "evaluated", node_id: 0, score: 10, eval_ok: true },
    ];
    for (let i = 1; i <= 6; i++) {
      recs.push({ kind: "node_created", node_id: i, parent_id: 0 });
      recs.push({ kind: "mutation_finished", node_id: i, ok: true });
      // Lower is better here, so these ARE improvements.
      recs.push({ kind: "evaluated", node_id: i, score: 10 - i, eval_ok: true });
    }
    expect(ids(build(recs))).not.toContain("no_progress");
  });

  it("flags training gains the holdout does not follow", () => {
    const recs: Array<Record<string, unknown>> = [
      { kind: "run_started", config: { budget: 4, metric_goal: "max" } },
      { kind: "node_created", node_id: 0, parent_id: null },
      { kind: "evaluated", node_id: 0, score: 10, eval_ok: true },
      { kind: "holdout_evaluated", node_id: 0, score: 10, ok: true },
    ];
    for (let i = 1; i <= 4; i++) {
      recs.push({ kind: "node_created", node_id: i, parent_id: 0 });
      recs.push({ kind: "mutation_finished", node_id: i, ok: true });
      recs.push({ kind: "evaluated", node_id: i, score: 10 + i * 2, eval_ok: true });
      recs.push({ kind: "holdout_evaluated", node_id: i, score: 9, ok: true });
    }
    expect(ids(build(recs))).toContain("overfit");
  });
});
