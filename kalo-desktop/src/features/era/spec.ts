/**
 * The `era-run.json` run spec: parse, validate, and turn into a command line.
 *
 * The spec is the contract between the natural-language wizard and the panel.
 * A kalo session (driven by the `era-experiment-designer` skill) writes it as
 * a real file next to the seed it also produced; the panel reads it back. It
 * is small and hand-writable on purpose — the wizard is a convenience, not a
 * requirement, and a user who prefers to write four lines of JSON can.
 *
 * Every field maps to an `era run` / `era serve` flag except two display-only
 * ones (`evolves`, `scoreMeaning`) that era never sees.
 */

/** Parsed, defaulted spec. */
export interface EraRunSpec {
  version: number;
  /** Run name; also the output subdirectory. */
  name: string;
  /** `--task`: natural-language goal handed to the mutating agent. */
  task: string;
  /** `--seed`: relative to the spec file's directory. */
  seed: string;
  /** `--eval`: run inside the node workspace; last stdout line is the score. */
  evalCmd: string;
  metricGoal: "max" | "min";
  budget: number;
  evalTimeout: number;
  mutateTimeout: number;
  maxSteps: number;
  evalRepeats: number;
  evalAggregate: string;
  bestBy: string;
  lcbZ: number;
  cPuct: number;
  holdoutEval: string | null;
  holdoutWhen: string;
  recombineEvery: number;
  ideas: string | null;
  extraInstruction: string;
  /** Display only: which files are meant to evolve. Used by the gate checks. */
  evolves: string[];
  /** Display only: one sentence on how to read the score. */
  scoreMeaning: string;
  /**
   * How to invoke era. Defaults to `era` on PATH; a venv install (the common
   * case for a Python tool on Windows) needs the full path to the executable.
   */
  eraBin: string | null;
}

/** Defaults mirror era's own argparse defaults (`era/cli.py:59-123`). */
export const SPEC_DEFAULTS = {
  metricGoal: "max" as const,
  budget: 20,
  evalTimeout: 300,
  mutateTimeout: 1200,
  maxSteps: 20,
  evalRepeats: 1,
  evalAggregate: "mean",
  bestBy: "mean",
  lcbZ: 1.0,
  cPuct: 1.0,
  holdoutWhen: "best",
  recombineEvery: 4,
};

/** Fields the spec may carry. Anything else is an error, not a silent drop. */
const KNOWN_KEYS = new Set([
  "version",
  "name",
  "task",
  "seed",
  "eval",
  "metricGoal",
  "budget",
  "evalTimeout",
  "mutateTimeout",
  "maxSteps",
  "evalRepeats",
  "evalAggregate",
  "bestBy",
  "lcbZ",
  "cPuct",
  "holdoutEval",
  "holdoutWhen",
  "recombineEvery",
  "ideas",
  "extraInstruction",
  "evolves",
  "scoreMeaning",
  "eraBin",
]);

export type SpecParse =
  | { ok: true; spec: EraRunSpec }
  | { ok: false; error: string };

function positiveInt(v: unknown, field: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${field} 必须是正整数，当前是 ${JSON.stringify(v)}`);
  }
  return n;
}

function positiveNum(v: unknown, field: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} 必须是正数，当前是 ${JSON.stringify(v)}`);
  }
  return n;
}

function requiredString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`缺少必填字段 ${field}`);
  }
  return v.trim();
}

/**
 * Parse `era-run.json` text. Unknown fields are rejected rather than ignored:
 * a typo'd key would otherwise silently take no effect, and the user would
 * spend a whole run wondering why their budget was 20.
 */
export function parseSpec(text: string): SpecParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "顶层必须是一个对象" };
  }
  const o = raw as Record<string, unknown>;

  const unknown = Object.keys(o).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `不认识的字段：${unknown.join(", ")}` };
  }

  const version = o.version === undefined ? 1 : Number(o.version);
  if (version !== 1) {
    return { ok: false, error: `不支持的 version：${String(o.version)}（当前只认 1）` };
  }

  try {
    const spec: EraRunSpec = {
      version: 1,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : "run",
      task: requiredString(o.task, "task"),
      seed: requiredString(o.seed, "seed"),
      evalCmd: requiredString(o.eval, "eval"),
      metricGoal: o.metricGoal === "min" ? "min" : SPEC_DEFAULTS.metricGoal,
      budget: positiveInt(o.budget, "budget", SPEC_DEFAULTS.budget),
      evalTimeout: positiveNum(o.evalTimeout, "evalTimeout", SPEC_DEFAULTS.evalTimeout),
      mutateTimeout: positiveNum(o.mutateTimeout, "mutateTimeout", SPEC_DEFAULTS.mutateTimeout),
      maxSteps: positiveInt(o.maxSteps, "maxSteps", SPEC_DEFAULTS.maxSteps),
      evalRepeats: positiveInt(o.evalRepeats, "evalRepeats", SPEC_DEFAULTS.evalRepeats),
      evalAggregate: typeof o.evalAggregate === "string" ? o.evalAggregate : SPEC_DEFAULTS.evalAggregate,
      bestBy: typeof o.bestBy === "string" ? o.bestBy : SPEC_DEFAULTS.bestBy,
      lcbZ: positiveNum(o.lcbZ, "lcbZ", SPEC_DEFAULTS.lcbZ),
      cPuct: positiveNum(o.cPuct, "cPuct", SPEC_DEFAULTS.cPuct),
      holdoutEval: typeof o.holdoutEval === "string" && o.holdoutEval.trim() ? o.holdoutEval.trim() : null,
      holdoutWhen: typeof o.holdoutWhen === "string" ? o.holdoutWhen : SPEC_DEFAULTS.holdoutWhen,
      recombineEvery: positiveInt(o.recombineEvery, "recombineEvery", SPEC_DEFAULTS.recombineEvery),
      ideas: typeof o.ideas === "string" && o.ideas.trim() ? o.ideas.trim() : null,
      extraInstruction: typeof o.extraInstruction === "string" ? o.extraInstruction : "",
      evolves: Array.isArray(o.evolves) ? o.evolves.filter((x): x is string => typeof x === "string") : [],
      scoreMeaning: typeof o.scoreMeaning === "string" ? o.scoreMeaning : "",
      eraBin: typeof o.eraBin === "string" && o.eraBin.trim() ? o.eraBin.trim() : null,
    };
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * POSIX single-quote escaping. The gateway launches jobs through `bash -c`
 * on every platform (gateway-backend.ts), so this is the right quoting even
 * on Windows — and it is the only reason a path with a space or a Chinese
 * character does not silently become two arguments.
 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Where the era binary is invoked from; overridable for a venv install. */
export interface EraLaunchOptions {
  /** Absolute path to the run's output directory (must not exist yet). */
  outDir: string;
  /** Absolute path to the seed directory. */
  seedDir: string;
  /** Absolute path to kalo's bundled pi executable. */
  agentBin: string;
  /** Defaults to `era`; a venv install can pass a full path. */
  eraBin?: string;
}

/**
 * Build the `era serve` command line.
 *
 * Two things here are not negotiable:
 *
 * - **`-q`**. A command job redirects `exec >> log 2>&1`, so era's
 *   human-readable stderr chatter would land in the same file as the NDJSON.
 *   The folder tolerates that, but there is no reason to create the mess.
 * - **`--agent-bin`**. era must use kalo's own pi, not whatever is on PATH,
 *   or the run silently uses a different agent than the user configured.
 */
export function buildServeCommand(spec: EraRunSpec, opts: EraLaunchOptions): string {
  const era = opts.eraBin?.trim() || "era";
  const args: string[] = [
    era,
    "serve",
    "-q",
    "--task",
    shq(spec.task),
    "--seed",
    shq(opts.seedDir),
    "--eval",
    shq(spec.evalCmd),
    "--metric-goal",
    spec.metricGoal,
    "--budget",
    String(spec.budget),
    "--out",
    shq(opts.outDir),
    "--agent-bin",
    shq(opts.agentBin),
    "--eval-timeout",
    String(spec.evalTimeout),
    "--mutate-timeout",
    String(spec.mutateTimeout),
    "--max-steps",
    String(spec.maxSteps),
    "--c-puct",
    String(spec.cPuct),
    "--eval-repeats",
    String(spec.evalRepeats),
    "--eval-aggregate",
    spec.evalAggregate,
    "--best-by",
    spec.bestBy,
    "--lcb-z",
    String(spec.lcbZ),
    "--recombine-every",
    String(spec.recombineEvery),
  ];
  if (spec.holdoutEval) {
    args.push("--holdout-eval", shq(spec.holdoutEval), "--holdout-when", spec.holdoutWhen);
  }
  if (spec.ideas) args.push("--ideas", shq(spec.ideas));
  if (spec.extraInstruction) args.push("--extra-instruction", shq(spec.extraInstruction));
  return args.join(" ");
}

/** Serialize back to `era-run.json` text (stable key order, 2-space indent). */
export function serializeSpec(spec: EraRunSpec): string {
  const o: Record<string, unknown> = {
    version: 1,
    name: spec.name,
    task: spec.task,
    seed: spec.seed,
    eval: spec.evalCmd,
    metricGoal: spec.metricGoal,
    budget: spec.budget,
    evalTimeout: spec.evalTimeout,
    maxSteps: spec.maxSteps,
    evalRepeats: spec.evalRepeats,
    evolves: spec.evolves,
    scoreMeaning: spec.scoreMeaning,
  };
  // Only write the advanced knobs that actually differ from era's defaults —
  // a spec full of default values reads as if someone chose them.
  if (spec.mutateTimeout !== SPEC_DEFAULTS.mutateTimeout) o.mutateTimeout = spec.mutateTimeout;
  if (spec.evalAggregate !== SPEC_DEFAULTS.evalAggregate) o.evalAggregate = spec.evalAggregate;
  if (spec.bestBy !== SPEC_DEFAULTS.bestBy) o.bestBy = spec.bestBy;
  if (spec.lcbZ !== SPEC_DEFAULTS.lcbZ) o.lcbZ = spec.lcbZ;
  if (spec.cPuct !== SPEC_DEFAULTS.cPuct) o.cPuct = spec.cPuct;
  if (spec.holdoutEval) o.holdoutEval = spec.holdoutEval;
  if (spec.holdoutWhen !== SPEC_DEFAULTS.holdoutWhen) o.holdoutWhen = spec.holdoutWhen;
  if (spec.recombineEvery !== SPEC_DEFAULTS.recombineEvery) o.recombineEvery = spec.recombineEvery;
  if (spec.ideas) o.ideas = spec.ideas;
  if (spec.extraInstruction) o.extraInstruction = spec.extraInstruction;
  if (spec.eraBin) o.eraBin = spec.eraBin;
  return `${JSON.stringify(o, null, 2)}\n`;
}
