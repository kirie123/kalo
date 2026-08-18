/**
 * era trace vocabulary and the folded search tree.
 *
 * Everything era-specific in kalo-desktop lives under `src/features/era/`.
 * Delete this directory and nothing else breaks: the base layers (harness,
 * gateway, Rust, protocol) carry zero era vocabulary — era is just a command
 * job whose output file this feature knows how to read.
 *
 * The event names and field names below mirror `era/events.py` (TRACE_KINDS)
 * and the `self.emit(...)` call sites in `era/search.py`. They are era's
 * on-disk contract, not ours: when era changes, this file changes.
 */

/** Record kinds written to `<out>/trace.jsonl` (era/events.py TRACE_KINDS). */
export type EraTraceKind =
  | "run_started"
  | "config_warning"
  | "select"
  | "node_created"
  | "mutation_started"
  | "engine_event"
  | "mutation_finished"
  | "fixtures_restored"
  | "evaluated"
  | "holdout_evaluated"
  | "operator_fallback"
  | "backprop"
  | "run_interrupted"
  | "run_finished";

/**
 * One raw trace record. Deliberately loose: era may add fields, and a folder
 * that rejects unknown shapes would break on the next era release. Readers
 * take what they recognise and ignore the rest.
 */
export interface EraTraceRecord {
  kind: string;
  /** Monotonic sequence number era assigns on write. */
  seq?: number;
  /** Epoch **seconds** (float), not milliseconds — era writes `time.time()`. */
  ts?: number;
  [key: string]: unknown;
}

/** Why a node is not showing a score yet, or why it never will. */
export type EraNodeState =
  | "mutating"
  | "evaluating"
  | "ok"
  | "eval_failed"
  | "mutation_failed";

/** One node of the folded tree. */
export interface EraNode {
  id: number;
  parent: number | null;
  name: string;
  /** Path relative to the run's out dir (`nodes/<name>`), from `node_created`. */
  path: string | null;
  score: number | null;
  evalOk: boolean;
  /** Present once evaluated; era's own words for why the eval failed. */
  evalReason: string | null;
  evalReturncode: number | null;
  evalDurationS: number | null;
  stdoutTail: string;
  stderrTail: string;
  /** Repeated-eval statistics; empty/null with the default `--eval-repeats 1`. */
  samples: number[];
  scoreStd: number | null;
  scoreSem: number | null;
  /** What FUTS ranks by — differs from `score` under `--best-by lcb`. */
  selectionScore: number | null;
  /** Measured on data the search never saw; null unless `--holdout-eval`. */
  holdoutScore: number | null;
  holdoutOk: boolean | null;
  holdoutReason: string | null;
  numVisits: number;
  costUsd: number;
  /** False once a `mutation_finished` reported the engine gave no cost. */
  costKnown: boolean;
  mutationOk: boolean;
  mutationReason: string | null;
  llmSteps: number | null;
  toolCalls: number | null;
  model: string | null;
  lastAgentMessage: string;
  operator: string;
  donors: number[];
  ideaId: string | null;
  /** Search iteration that produced this node; null for the seed. */
  iteration: number | null;
  /** True between `mutation_started` and `mutation_finished`. */
  mutating: boolean;
  /** Rank/PUCT from the most recent `select` that considered this node. */
  rankScore: number | null;
  puct: number | null;
}

/** The whole folded run. */
export interface EraTree {
  nodes: EraNode[];
  /** Node ids in creation order — the order era writes them. */
  order: number[];
  config: Record<string, unknown>;
  metricGoal: "max" | "min";
  totalCostUsd: number;
  costComplete: boolean;
  /** Search iterations completed (highest `select` iteration seen). */
  iteration: number;
  budget: number | null;
  finished: boolean;
  interrupted: boolean;
  /** From `run_finished`; before that, computed by {@link bestNode}. */
  bestNodeId: number | null;
  /** best_score − holdout_score at the end, when era reported one. */
  selectionGap: number | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  /** `config_warning` records — era's own complaints about the run config. */
  warnings: string[];
  /** Lines that failed to parse as JSON. Non-zero means something polluted
   * the file (era's chatter without `-q`, or a partial final line). */
  unparsedLines: number;
}

/** A human-readable projection of one record, for the event stream view. */
export interface EraEventLine {
  seq: number;
  kind: string;
  timeMs: number | null;
  nodeId: number | null;
  /** One-line summary; the raw record stays available for copying. */
  text: string;
  failure: boolean;
  raw: EraTraceRecord;
}
