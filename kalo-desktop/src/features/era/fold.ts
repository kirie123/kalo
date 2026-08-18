/**
 * Fold era's NDJSON trace into a search tree.
 *
 * Structurally the same job as `era/trace.py:rebuild_tree`, with two
 * differences that come from being a live panel rather than a replay tool:
 *
 * 1. **Incremental.** Bytes arrive in chunks from `read_text_since`, so the
 *    folder buffers a partial trailing line and folds each complete line once.
 * 2. **Richer per node.** `rebuild_tree` keeps only what `era replay` must
 *    verify; a debugging panel also needs failure reasons, output tails,
 *    holdout scores and engine step counts.
 *
 * Unparseable lines are skipped and counted, never thrown on. era's own
 * human-readable log goes to stderr, and a command job redirects `2>&1` into
 * one file — so if `-q` is ever dropped from the command line, this file is
 * what keeps the panel working instead of dying on line one.
 */

import type { EraEventLine, EraNode, EraNodeState, EraTraceRecord, EraTree } from "./types";

/** How many folded event lines to keep for the event-stream view. */
const MAX_EVENT_LINES = 400;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function intOrNull(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function newNode(id: number, parent: number | null, name: string): EraNode {
  return {
    id,
    parent,
    name,
    path: null,
    score: null,
    evalOk: false,
    evalReason: null,
    evalReturncode: null,
    evalDurationS: null,
    stdoutTail: "",
    stderrTail: "",
    samples: [],
    scoreStd: null,
    scoreSem: null,
    selectionScore: null,
    holdoutScore: null,
    holdoutOk: null,
    holdoutReason: null,
    numVisits: 0,
    costUsd: 0,
    costKnown: true,
    mutationOk: true,
    mutationReason: null,
    llmSteps: null,
    toolCalls: null,
    model: null,
    lastAgentMessage: "",
    operator: parent === null ? "seed" : "mutate",
    donors: [],
    ideaId: null,
    iteration: null,
    mutating: false,
    rankScore: null,
    puct: null,
  };
}

/** What to show for a node: the four failure modes plus the two live states. */
export function nodeState(n: EraNode): EraNodeState {
  if (!n.mutationOk) return "mutation_failed";
  if (n.mutating) return "mutating";
  if (n.score === null) return "evaluating";
  return n.evalOk ? "ok" : "eval_failed";
}

/**
 * Best node under the run's metric goal. Ties break toward the earliest node,
 * matching `ReplayTree.best()` — and therefore matching what era itself
 * exports as the winner.
 */
export function bestNode(tree: EraTree): EraNode | null {
  const scored = tree.nodes.filter((n) => n.score !== null);
  if (scored.length === 0) return null;
  const sign = tree.metricGoal === "max" ? 1 : -1;
  let best = scored[0];
  for (const n of scored.slice(1)) {
    const a = sign * (n.score as number);
    const b = sign * (best.score as number);
    if (a > b || (a === b && n.id < best.id)) best = n;
  }
  return best;
}

/** Children of `id` (pass null for the roots), in creation order. */
export function childrenOf(tree: EraTree, id: number | null): EraNode[] {
  return tree.nodes.filter((n) => n.parent === id);
}

/**
 * best-so-far series: one point per evaluated node in creation order, the y
 * value being the best score seen up to and including it. Failed evaluations
 * are excluded — era scores them at the worst possible value, and plotting
 * that flattens every real curve into a single spike.
 */
export function bestSoFarSeries(tree: EraTree): Array<{ x: number; y: number }> {
  const sign = tree.metricGoal === "max" ? 1 : -1;
  const out: Array<{ x: number; y: number }> = [];
  let best: number | null = null;
  for (const id of tree.order) {
    const n = tree.nodes.find((v) => v.id === id);
    if (!n || n.score === null || !n.evalOk) continue;
    if (best === null || sign * n.score > sign * best) best = n.score;
    out.push({ x: n.id, y: best });
  }
  return out;
}

/**
 * Incremental NDJSON → tree folder.
 *
 * One instance per run being viewed. `push()` is byte-chunk oriented so it
 * pairs directly with `read_text_since`; `reset()` handles the file having
 * been truncated or replaced under us.
 */
export class EraFolder {
  private buf = "";
  private seqCounter = 0;
  private readonly byId = new Map<number, EraNode>();
  private readonly tree: EraTree = {
    nodes: [],
    order: [],
    config: {},
    metricGoal: "max",
    totalCostUsd: 0,
    costComplete: true,
    iteration: 0,
    budget: null,
    finished: false,
    interrupted: false,
    bestNodeId: null,
    selectionGap: null,
    startedAtMs: null,
    finishedAtMs: null,
    warnings: [],
    unparsedLines: 0,
  };
  private lines: EraEventLine[] = [];

  /** Feed a chunk of file bytes. Handles a split trailing line. */
  push(chunk: string): void {
    if (!chunk) return;
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.feedLine(line);
      nl = this.buf.indexOf("\n");
    }
  }

  /** Discard everything; the caller re-reads the file from byte 0. */
  reset(): void {
    this.buf = "";
    this.seqCounter = 0;
    this.byId.clear();
    this.lines = [];
    Object.assign(this.tree, {
      nodes: [],
      order: [],
      config: {},
      metricGoal: "max",
      totalCostUsd: 0,
      costComplete: true,
      iteration: 0,
      budget: null,
      finished: false,
      interrupted: false,
      bestNodeId: null,
      selectionGap: null,
      startedAtMs: null,
      finishedAtMs: null,
      warnings: [],
      unparsedLines: 0,
    } satisfies EraTree);
  }

  /**
   * A snapshot of the tree. Nodes are ordered by id, so the array index is
   * stable while a run grows — React keys stay put.
   */
  snapshot(): EraTree {
    return {
      ...this.tree,
      nodes: [...this.byId.values()].sort((a, b) => a.id - b.id).map((n) => ({ ...n })),
      order: [...this.tree.order],
      warnings: [...this.tree.warnings],
    };
  }

  /** The most recent folded event lines, oldest first. */
  events(): EraEventLine[] {
    return this.lines;
  }

  // ------------------------------------------------------------------ folding

  private feedLine(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    let rec: EraTraceRecord;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as EraTraceRecord).kind !== "string") {
        this.tree.unparsedLines += 1;
        return;
      }
      rec = parsed as EraTraceRecord;
    } catch {
      // era's stderr chatter, or a half-written final line. Both are normal.
      this.tree.unparsedLines += 1;
      return;
    }
    this.apply(rec);
    this.record(rec);
  }

  private node(id: number, parent: number | null = null, name?: string): EraNode {
    let n = this.byId.get(id);
    if (!n) {
      n = newNode(id, parent, name ?? `n${String(id).padStart(4, "0")}`);
      this.byId.set(id, n);
      this.tree.order.push(id);
    }
    return n;
  }

  private apply(rec: EraTraceRecord): void {
    const tsMs = rec.ts !== undefined && num(rec.ts) !== null ? (rec.ts as number) * 1000 : null;
    switch (rec.kind) {
      case "run_started": {
        const config = (rec.config as Record<string, unknown>) ?? {};
        this.tree.config = config;
        this.tree.metricGoal = config.metric_goal === "min" ? "min" : "max";
        this.tree.budget = intOrNull(config.budget);
        this.tree.startedAtMs = tsMs;
        return;
      }
      case "config_warning": {
        const msg = str(rec.message) || str(rec.reason) || JSON.stringify(rec);
        this.tree.warnings.push(msg);
        return;
      }
      case "select": {
        const it = intOrNull(rec.iteration);
        if (it !== null) this.tree.iteration = Math.max(this.tree.iteration, it);
        // The candidate list carries the ranking that produced this choice —
        // the only place a panel can see *why* a parent was picked.
        for (const c of (rec.candidates as Array<Record<string, unknown>>) ?? []) {
          const id = intOrNull(c.node_id);
          if (id === null) continue;
          const n = this.byId.get(id);
          if (!n) continue;
          n.rankScore = num(c.rank_score);
          n.puct = num(c.puct);
        }
        return;
      }
      case "node_created": {
        const id = intOrNull(rec.node_id);
        if (id === null) return;
        const parent = intOrNull(rec.parent_id);
        const n = this.node(id, parent, str(rec.name) || undefined);
        n.parent = parent;
        if (str(rec.name)) n.name = str(rec.name);
        n.path = str(rec.path) || null;
        n.mutationOk = bool(rec.mutation_ok, true);
        n.operator = str(rec.operator) || (parent === null ? "seed" : "mutate");
        n.donors = ((rec.donors as unknown[]) ?? []).map((d) => Math.trunc(Number(d))).filter(Number.isFinite);
        n.ideaId = typeof rec.idea_id === "string" ? rec.idea_id : null;
        n.iteration = intOrNull(rec.iteration);
        const cost = num(rec.cost_usd) ?? 0;
        n.costUsd = cost;
        this.tree.totalCostUsd += cost;
        return;
      }
      case "mutation_started": {
        const id = intOrNull(rec.node_id);
        if (id === null) return;
        this.node(id).mutating = true;
        return;
      }
      case "mutation_finished": {
        const id = intOrNull(rec.node_id);
        if (id === null) return;
        const n = this.node(id);
        n.mutating = false;
        n.mutationOk = bool(rec.ok, n.mutationOk);
        n.mutationReason = str(rec.reason) || null;
        // era re-reports the node's *total* cost here, not a delta.
        const cost = num(rec.cost_usd) ?? 0;
        this.tree.totalCostUsd += cost - n.costUsd;
        n.costUsd = cost;
        n.costKnown = bool(rec.cost_known, true);
        if (!n.costKnown) this.tree.costComplete = false;
        n.llmSteps = intOrNull(rec.llm_steps);
        n.toolCalls = intOrNull(rec.tool_calls);
        n.model = str(rec.model) || null;
        n.lastAgentMessage = str(rec.last_agent_message);
        return;
      }
      case "evaluated": {
        const id = intOrNull(rec.node_id);
        if (id === null) return;
        const n = this.node(id);
        n.score = num(rec.score);
        n.evalOk = bool(rec.eval_ok, false);
        n.evalReason = str(rec.reason) || null;
        n.evalReturncode = intOrNull(rec.returncode);
        n.evalDurationS = num(rec.duration_s);
        n.stdoutTail = str(rec.stdout_tail);
        n.stderrTail = str(rec.stderr_tail);
        n.samples = ((rec.samples as unknown[]) ?? [])
          .map((s) => Number(s))
          .filter((s) => Number.isFinite(s));
        n.scoreStd = num(rec.score_std);
        n.scoreSem = num(rec.score_sem);
        n.selectionScore = num(rec.selection_score);
        return;
      }
      case "holdout_evaluated": {
        const id = intOrNull(rec.node_id);
        if (id === null) return;
        const n = this.node(id);
        // HoldoutResult.as_dict() spreads flat: score / ok / reason.
        n.holdoutScore = num(rec.score);
        n.holdoutOk = bool(rec.ok, false);
        n.holdoutReason = str(rec.reason) || null;
        return;
      }
      case "backprop": {
        for (const touched of (rec.touched as unknown[]) ?? []) {
          const id = intOrNull(touched);
          if (id === null) continue;
          const n = this.byId.get(id);
          if (n) n.numVisits += 1;
        }
        return;
      }
      case "run_interrupted": {
        this.tree.interrupted = true;
        this.tree.finishedAtMs = tsMs;
        return;
      }
      case "run_finished": {
        this.tree.finished = true;
        this.tree.finishedAtMs = tsMs;
        this.tree.bestNodeId = intOrNull(rec.best_node_id);
        this.tree.selectionGap = num(rec.selection_gap);
        const total = num(rec.total_cost_usd);
        if (total !== null) this.tree.totalCostUsd = total;
        this.tree.costComplete = bool(rec.cost_complete, this.tree.costComplete);
        return;
      }
      default:
        // engine_event / fixtures_restored / operator_fallback carry no tree
        // state; they still show up in the event stream below.
        return;
    }
  }

  // ------------------------------------------------------------- event lines

  private record(rec: EraTraceRecord): void {
    const nodeId = intOrNull(rec.node_id);
    const line: EraEventLine = {
      seq: intOrNull(rec.seq) ?? ++this.seqCounter,
      kind: rec.kind,
      timeMs: num(rec.ts) === null ? null : (rec.ts as number) * 1000,
      nodeId,
      text: describe(rec),
      failure: isFailure(rec),
      raw: rec,
    };
    this.lines.push(line);
    if (this.lines.length > MAX_EVENT_LINES) {
      this.lines = this.lines.slice(-MAX_EVENT_LINES);
    }
  }
}

/** True when a record reports something that went wrong. */
export function isFailure(rec: EraTraceRecord): boolean {
  switch (rec.kind) {
    case "evaluated":
      return !bool(rec.eval_ok, false);
    case "mutation_finished":
      return !bool(rec.ok, true);
    case "holdout_evaluated":
      return !bool(rec.ok, true);
    case "config_warning":
    case "operator_fallback":
    case "run_interrupted":
      return true;
    default:
      return false;
  }
}

function fmt(n: number | null, digits = 6): string {
  if (n === null) return "—";
  return Number.isInteger(n) ? String(n) : n.toPrecision(digits).replace(/\.?0+$/, "");
}

/** One-line human projection of a record. The raw JSON stays available. */
export function describe(rec: EraTraceRecord): string {
  switch (rec.kind) {
    case "run_started": {
      const cfg = (rec.config as Record<string, unknown>) ?? {};
      return `开始：预算 ${String(cfg.budget ?? "?")} 次扩展，目标 ${String(cfg.metric_goal ?? "max")}`;
    }
    case "config_warning":
      return `配置警告：${str(rec.message) || JSON.stringify(rec)}`;
    case "select":
      return `第 ${String(rec.iteration ?? "?")} 轮：选中 n${String(rec.selected_node_id ?? "?")}`;
    case "node_created":
      return `新节点 ${str(rec.name) || `n${String(rec.node_id)}`}（${str(rec.operator) || "mutate"}，父 n${String(rec.parent_id ?? "—")}）`;
    case "mutation_started":
      return `开始改写 n${String(rec.node_id)}`;
    case "mutation_finished":
      return bool(rec.ok, true)
        ? `改写完成 n${String(rec.node_id)}：${String(rec.llm_steps ?? "?")} 步 / ${String(rec.tool_calls ?? "?")} 次工具 / $${fmt(num(rec.cost_usd), 3)}`
        : `改写失败 n${String(rec.node_id)}：${str(rec.reason)}`;
    case "fixtures_restored":
      return `已还原评分文件：${((rec.files as unknown[]) ?? []).join(", ") || "无"}`;
    case "evaluated":
      return bool(rec.eval_ok, false)
        ? `评测 n${String(rec.node_id)} = ${fmt(num(rec.score))}（${fmt(num(rec.duration_s), 3)}s）`
        : `评测失败 n${String(rec.node_id)}：${str(rec.reason)}（退出码 ${String(rec.returncode ?? "—")}）`;
    case "holdout_evaluated":
      return bool(rec.ok, true)
        ? `留出集 n${String(rec.node_id)} = ${fmt(num(rec.score))}`
        : `留出集评测失败 n${String(rec.node_id)}：${str(rec.reason)}`;
    case "operator_fallback":
      return `算子回退：${str(rec.reason) || JSON.stringify(rec)}`;
    case "backprop":
      return `回传 n${String(rec.node_id)} → ${((rec.touched as unknown[]) ?? []).length} 个祖先`;
    case "engine_event":
      return `引擎事件 n${String(rec.node_id)}：${describeEngineEvent(rec.event)}`;
    case "run_interrupted":
      return `被中断（已有 ${String(rec.nodes ?? "?")} 个节点）`;
    case "run_finished":
      return `结束：最优 n${String(rec.best_node_id)} = ${fmt(num(rec.best_score))}，共 ${String(rec.num_nodes ?? "?")} 节点 / $${fmt(num(rec.total_cost_usd), 3)}`;
    default:
      return rec.kind;
  }
}

function describeEngineEvent(event: unknown): string {
  if (!event || typeof event !== "object") return String(event ?? "");
  const e = event as Record<string, unknown>;
  const type = str(e.type) || str(e.kind) || "?";
  const name = str(e.toolName) || str(e.tool_name) || str(e.name);
  return name ? `${type} ${name}` : type;
}
