import { describe, expect, it } from "vitest";
import { EraFolder, bestNode, bestSoFarSeries, childrenOf, describe as describeRec, isFailure, nodeState } from "./fold";

/** Build an NDJSON trace the way era's TraceWriter would. */
function trace(records: Array<Record<string, unknown>>): string {
  return records.map((r, i) => JSON.stringify({ seq: i, ts: 1_700_000_000 + i, ...r })).join("\n") + "\n";
}

const RUN = trace([
  { kind: "run_started", config: { budget: 4, metric_goal: "max", eval: "python eval.py" } },
  { kind: "node_created", node_id: 0, parent_id: null, name: "n0000", path: "nodes/n0000", operator: "seed", cost_usd: 0 },
  { kind: "evaluated", node_id: 0, score: 10, eval_ok: true, duration_s: 0.5, returncode: 0 },
  { kind: "select", iteration: 1, selected_node_id: 0, candidates: [{ node_id: 0, score: 10, rank_score: 10, puct: 1.5, num_visits: 0 }] },
  { kind: "node_created", node_id: 1, parent_id: 0, name: "n0001", path: "nodes/n0001", operator: "mutate", cost_usd: 0.02, iteration: 1 },
  { kind: "mutation_started", node_id: 1 },
  { kind: "mutation_finished", node_id: 1, ok: true, cost_usd: 0.05, cost_known: true, llm_steps: 7, tool_calls: 12, model: "opus" },
  { kind: "evaluated", node_id: 1, score: 25, eval_ok: true, duration_s: 0.6, returncode: 0 },
  { kind: "backprop", node_id: 1, touched: [1, 0] },
  { kind: "select", iteration: 2, selected_node_id: 1, candidates: [{ node_id: 1, score: 25, rank_score: 25, puct: 2.5, num_visits: 1 }] },
  { kind: "node_created", node_id: 2, parent_id: 1, name: "n0002", path: "nodes/n0002", operator: "mutate", cost_usd: 0.01, iteration: 2 },
  { kind: "mutation_finished", node_id: 2, ok: true, cost_usd: 0.03, cost_known: true },
  { kind: "evaluated", node_id: 2, score: -1e9, eval_ok: false, reason: "timeout", returncode: -9, stderr_tail: "killed" },
  { kind: "backprop", node_id: 2, touched: [2, 1, 0] },
  { kind: "run_finished", best_node_id: 1, best_score: 25, num_nodes: 3, total_cost_usd: 0.08, cost_complete: true },
]);

function fold(text: string) {
  const f = new EraFolder();
  f.push(text);
  return f;
}

describe("EraFolder", () => {
  it("rebuilds nodes, parents, scores and visits like rebuild_tree", () => {
    const t = fold(RUN).snapshot();
    expect(t.nodes.map((n) => n.id)).toEqual([0, 1, 2]);
    expect(t.nodes.map((n) => n.parent)).toEqual([null, 0, 1]);
    expect(t.nodes.map((n) => n.score)).toEqual([10, 25, -1e9]);
    // backprop touched 0 twice, 1 twice, 2 once.
    expect(t.nodes.map((n) => n.numVisits)).toEqual([2, 2, 1]);
    expect(t.metricGoal).toBe("max");
    expect(t.budget).toBe(4);
    expect(t.finished).toBe(true);
    expect(t.bestNodeId).toBe(1);
  });

  it("treats mutation_finished cost as a total, not a delta", () => {
    // node_created said 0.02 and 0.01; mutation_finished re-reported 0.05 and
    // 0.03. Adding instead of replacing would give 0.11.
    const f = new EraFolder();
    f.push(RUN.split("\n").slice(0, -2).join("\n") + "\n"); // everything but run_finished
    const t = f.snapshot();
    expect(t.totalCostUsd).toBeCloseTo(0.08, 10);
  });

  it("takes the authoritative total from run_finished", () => {
    expect(fold(RUN).snapshot().totalCostUsd).toBeCloseTo(0.08, 10);
  });

  it("records ranking from the select candidate list", () => {
    const t = fold(RUN).snapshot();
    expect(t.nodes[1].puct).toBe(2.5);
    expect(t.nodes[1].rankScore).toBe(25);
    expect(t.iteration).toBe(2);
  });

  it("keeps the engine details a debugger needs", () => {
    const n = fold(RUN).snapshot().nodes[1];
    expect(n.llmSteps).toBe(7);
    expect(n.toolCalls).toBe(12);
    expect(n.model).toBe("opus");
    expect(n.path).toBe("nodes/n0001");
  });

  it("keeps the failure reason and stderr for a failed eval", () => {
    const n = fold(RUN).snapshot().nodes[2];
    expect(n.evalOk).toBe(false);
    expect(n.evalReason).toBe("timeout");
    expect(n.evalReturncode).toBe(-9);
    expect(n.stderrTail).toBe("killed");
  });

  it("folds identically whether bytes arrive whole or split mid-line", () => {
    const whole = fold(RUN).snapshot();
    const split = new EraFolder();
    for (let i = 0; i < RUN.length; i += 7) split.push(RUN.slice(i, i + 7));
    expect(split.snapshot()).toEqual(whole);
  });

  it("holds back a trailing partial line until its newline arrives", () => {
    const f = new EraFolder();
    const cut = RUN.lastIndexOf("\n", RUN.length - 2) + 1;
    f.push(RUN.slice(0, cut) + `{"kind":"node_cre`);
    expect(f.snapshot().unparsedLines).toBe(0);
    expect(f.snapshot().nodes).toHaveLength(3);
  });

  it("counts unparseable lines instead of throwing", () => {
    // What a run without -q looks like: era's human log interleaved with JSON.
    const f = fold(`not json\n${RUN}[era] iteration 3/4\n\n`);
    const t = f.snapshot();
    expect(t.unparsedLines).toBe(2);
    expect(t.nodes).toHaveLength(3);
  });

  it("counts JSON without a kind as unparseable", () => {
    expect(fold(`{"seq":0,"ts":1}\n`).snapshot().unparsedLines).toBe(1);
  });

  it("reset() returns it to the empty state for a truncated file", () => {
    const f = fold(RUN);
    f.reset();
    const t = f.snapshot();
    expect(t.nodes).toEqual([]);
    expect(t.totalCostUsd).toBe(0);
    expect(t.finished).toBe(false);
    f.push(RUN);
    expect(f.snapshot().nodes).toHaveLength(3);
  });

  it("converts era's epoch seconds to milliseconds", () => {
    const t = fold(RUN).snapshot();
    expect(t.startedAtMs).toBe(1_700_000_000_000);
  });

  it("marks a run interrupted without marking it finished", () => {
    const t = fold(trace([{ kind: "run_started", config: {} }, { kind: "run_interrupted", nodes: 2 }])).snapshot();
    expect(t.interrupted).toBe(true);
    expect(t.finished).toBe(false);
  });

  it("collects config warnings", () => {
    const t = fold(trace([{ kind: "config_warning", message: "eval-repeats>1 但 best-by=mean" }])).snapshot();
    expect(t.warnings).toEqual(["eval-repeats>1 但 best-by=mean"]);
  });

  it("keeps holdout results flat, as HoldoutResult.as_dict writes them", () => {
    const t = fold(
      RUN + trace([{ kind: "holdout_evaluated", node_id: 1, score: 18, ok: true }]),
    ).snapshot();
    expect(t.nodes[1].holdoutScore).toBe(18);
    expect(t.nodes[1].holdoutOk).toBe(true);
  });

  it("caps the event list but keeps the newest", () => {
    const many = trace(Array.from({ length: 600 }, (_, i) => ({ kind: "mutation_started", node_id: i })));
    const f = fold(many);
    const ev = f.events();
    expect(ev).toHaveLength(400);
    expect(ev[ev.length - 1].nodeId).toBe(599);
  });
});

describe("derived views", () => {
  it("picks the best node under a max goal", () => {
    expect(bestNode(fold(RUN).snapshot())?.id).toBe(1);
  });

  it("picks the best node under a min goal", () => {
    const t = fold(RUN).snapshot();
    expect(bestNode({ ...t, metricGoal: "min" })?.id).toBe(2);
  });

  it("breaks ties toward the earliest node, as ReplayTree.best does", () => {
    const t = fold(
      trace([
        { kind: "node_created", node_id: 0, parent_id: null },
        { kind: "evaluated", node_id: 0, score: 5, eval_ok: true },
        { kind: "node_created", node_id: 1, parent_id: 0 },
        { kind: "evaluated", node_id: 1, score: 5, eval_ok: true },
      ]),
    ).snapshot();
    expect(bestNode(t)?.id).toBe(0);
  });

  it("has no best node before anything is evaluated", () => {
    expect(bestNode(fold(trace([{ kind: "node_created", node_id: 0 }])).snapshot())).toBeNull();
  });

  it("excludes failed evals from the best-so-far curve", () => {
    // n2 scored -1e9 because it failed; including it would flatten the curve.
    expect(bestSoFarSeries(fold(RUN).snapshot())).toEqual([
      { x: 0, y: 10 },
      { x: 1, y: 25 },
    ]);
  });

  it("lists children in creation order", () => {
    const t = fold(RUN).snapshot();
    expect(childrenOf(t, null).map((n) => n.id)).toEqual([0]);
    expect(childrenOf(t, 0).map((n) => n.id)).toEqual([1]);
  });
});

describe("nodeState", () => {
  const t = fold(RUN).snapshot();
  it("names each of the states the panel colours by", () => {
    expect(nodeState(t.nodes[1])).toBe("ok");
    expect(nodeState(t.nodes[2])).toBe("eval_failed");
    expect(nodeState({ ...t.nodes[1], mutating: true })).toBe("mutating");
    expect(nodeState({ ...t.nodes[1], score: null })).toBe("evaluating");
    expect(nodeState({ ...t.nodes[1], mutationOk: false })).toBe("mutation_failed");
  });

  it("prefers mutation failure over any later state", () => {
    expect(nodeState({ ...t.nodes[1], mutationOk: false, mutating: true })).toBe("mutation_failed");
  });
});

describe("isFailure / describe", () => {
  it("flags the records the failure banner counts", () => {
    expect(isFailure({ kind: "evaluated", eval_ok: false })).toBe(true);
    expect(isFailure({ kind: "evaluated", eval_ok: true })).toBe(false);
    expect(isFailure({ kind: "mutation_finished", ok: false })).toBe(true);
    expect(isFailure({ kind: "operator_fallback" })).toBe(true);
    expect(isFailure({ kind: "node_created" })).toBe(false);
  });

  it("projects a record to one line without throwing on missing fields", () => {
    expect(describeRec({ kind: "evaluated", node_id: 2, eval_ok: false, reason: "timeout" })).toContain("评测失败");
    expect(describeRec({ kind: "something_new" })).toBe("something_new");
  });
});
