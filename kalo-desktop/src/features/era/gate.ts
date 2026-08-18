/**
 * The verification gate: six mechanical checks run against the untouched seed
 * before a single dollar is spent.
 *
 * Why this exists at all. era's entire value rests on the eval being
 * trustworthy — it will climb the same hill twenty times, and an `eval.py`
 * that measures the wrong thing turns the whole run into an optimisation of a
 * bug, with a rising score the whole way. Nothing downstream can detect that.
 * A human glance at a baseline number and a source file can.
 *
 * Every check here is **mechanical**: it compares strings and numbers that
 * were actually produced by running the eval. None of them asks a model
 * whether an eval "looks right" — that would be the same trust problem one
 * level up.
 */

import type { EraRunSpec } from "./spec";

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface GateCheck {
  id:
    | "score_parses"
    | "exit_code"
    | "deterministic"
    | "scorer_protected"
    | "target_not_protected"
    | "timeout_headroom";
  label: string;
  status: CheckStatus;
  /** What was actually observed. */
  detail: string;
  /** What to do about it, when it is not a pass. */
  hint?: string;
}

/** Result of one eval run performed by the gate. */
export interface EvalProbe {
  /** Complete stdout. */
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationS: number;
  /** True when the probe could not be run at all (era/bash missing, …). */
  launchError?: string;
}

export interface GateInput {
  spec: EraRunSpec;
  /** First run on the pristine seed. */
  first: EvalProbe;
  /** Optional second run, for the determinism check. */
  second?: EvalProbe;
  /** Lines of `<seed>/.era-fixtures`, comments and blanks already stripped. */
  fixtures: string[];
  /** True when `<seed>/.era-fixtures` exists at all. */
  fixturesPresent: boolean;
  /** Total bytes of the seed tree, for the size warning. */
  seedBytes?: number;
}

export interface GateResult {
  checks: GateCheck[];
  /** Parsed baseline score; null when the last line is not a number. */
  baseline: number | null;
  /**
   * False only when starting is guaranteed to be pointless — that is, when
   * the score cannot be parsed. Everything else is a warning: the user may
   * legitimately know better than these six rules.
   */
  canStart: boolean;
  /** Advisory notes that are not checks (seed size, and similar). */
  notes: string[];
}

/**
 * Parse a score the way era does: the **last non-empty line of stdout**, as a
 * float (`era/evaluate.py`). Not "a number somewhere in the output" — matching
 * era exactly is the point, so that a pass here means a pass there.
 */
export function parseScoreLine(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1].trim();
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

/** Strip comments and blanks from a manifest file's text. */
export function parseManifest(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/\\/g, "/"));
}

/**
 * Script-ish tokens mentioned by an eval command, used to ask "is the thing
 * that computes the score protected?". Intentionally crude: it looks for
 * path-like arguments, because that is what a manifest lists.
 */
export function scriptsInCommand(cmd: string): string[] {
  const out: string[] = [];
  for (const rawToken of cmd.split(/\s+/)) {
    const token = rawToken.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
    if (!token || token.startsWith("-")) continue;
    // A bare interpreter name is not the scorer; a path or a file with an
    // extension is a candidate.
    if (/\.[A-Za-z0-9]+$/.test(token) || token.includes("/")) out.push(token);
  }
  return out;
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function runGateChecks(input: GateInput): GateResult {
  const { spec, first, second, fixtures, fixturesPresent } = input;
  const checks: GateCheck[] = [];
  const notes: string[] = [];

  // 1. The score line ------------------------------------------------------
  const baseline = first.launchError ? null : parseScoreLine(first.stdout);
  const lastLine =
    first.stdout.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-1)[0]?.trim() ?? "";
  checks.push({
    id: "score_parses",
    label: "最后一行能解析成数字",
    status: baseline === null ? "fail" : "pass",
    detail: first.launchError
      ? `评测没能跑起来：${first.launchError}`
      : baseline === null
        ? `最后一行是 ${lastLine ? JSON.stringify(lastLine) : "（没有输出）"}`
        : String(baseline),
    hint:
      baseline === null
        ? "era 只认 stdout 的最后一行。让评测脚本把分数单独打在最后一行，诊断信息放在它前面。"
        : undefined,
  });

  // 2. Exit code -----------------------------------------------------------
  checks.push({
    id: "exit_code",
    label: "退出码为 0",
    status: first.launchError ? "fail" : first.exitCode === 0 ? "pass" : "warn",
    detail: first.launchError ? "未执行" : `退出码 ${String(first.exitCode ?? "—")}`,
    hint:
      !first.launchError && first.exitCode !== 0
        ? "非零退出会让 era 把这次评测记成失败，整棵树都会是失败节点。"
        : undefined,
  });

  // 3. Determinism ---------------------------------------------------------
  if (!second || second.launchError) {
    checks.push({
      id: "deterministic",
      label: "跑两次分数一致",
      status: "unknown",
      detail: "未做第二次评测",
    });
  } else {
    const b2 = parseScoreLine(second.stdout);
    const same = baseline !== null && b2 !== null && baseline === b2;
    checks.push({
      id: "deterministic",
      label: "跑两次分数一致",
      status: same ? "pass" : "warn",
      detail: same ? "确定性评测" : `第一次 ${String(baseline)} / 第二次 ${String(b2)}`,
      hint: same
        ? undefined
        : "分数带噪声时搜索会追随机数。用 --eval-repeats 3 --best-by lcb 让 era 按下界排序。",
    });
  }

  // 4. Is the scorer protected? -------------------------------------------
  const fx = fixtures.map(normalise);
  const scripts = scriptsInCommand(spec.evalCmd).map(normalise);
  const protectedScripts = scripts.filter((s) => fx.some((f) => f === s || s.endsWith(`/${f}`) || f.endsWith(`/${s}`)));
  checks.push({
    id: "scorer_protected",
    label: "评分脚本已受保护",
    status: !fixturesPresent ? "warn" : protectedScripts.length > 0 ? "pass" : "warn",
    detail: !fixturesPresent
      ? "seed 里没有 .era-fixtures"
      : protectedScripts.length > 0
        ? `.era-fixtures: ${protectedScripts.join(", ")}`
        : `.era-fixtures 里没有 ${scripts.join(" / ") || "评测脚本"}`,
    hint:
      fixturesPresent && protectedScripts.length > 0
        ? undefined
        : "评分脚本不在 .era-fixtures 里，变异 agent 可以改写它来刷分——分数会一路上涨而程序没变好。",
  });

  // 5. Is the thing that should evolve accidentally frozen? ----------------
  const evolves = spec.evolves.map(normalise);
  const frozen = evolves.filter((e) => fx.some((f) => f === e));
  checks.push({
    id: "target_not_protected",
    label: "待演化文件未被保护",
    status: evolves.length === 0 ? "unknown" : frozen.length === 0 ? "pass" : "fail",
    detail:
      evolves.length === 0
        ? "spec 没有写 evolves"
        : frozen.length === 0
          ? evolves.join(", ")
          : `${frozen.join(", ")} 同时在 .era-fixtures 里`,
    hint:
      frozen.length > 0
        ? "受保护的文件每次评测前都会被还原成 seed 的样子，改了等于没改，分数永远不动。"
        : undefined,
  });

  // 6. Timeout headroom ----------------------------------------------------
  const dur = first.launchError ? null : first.durationS;
  const headroom = dur === null ? null : dur * 3 <= spec.evalTimeout;
  checks.push({
    id: "timeout_headroom",
    label: "耗时远小于超时",
    status: headroom === null ? "unknown" : headroom ? "pass" : "warn",
    detail: dur === null ? "未执行" : `${dur.toFixed(1)}s / ${spec.evalTimeout}s`,
    hint:
      headroom === false
        ? "变异后的程序通常比 seed 更慢。留出至少 3 倍余量，否则会大量超时，预算白烧。"
        : undefined,
  });

  if (input.seedBytes !== undefined && input.seedBytes > 200 * 1024 * 1024) {
    notes.push(
      `seed 有 ${(input.seedBytes / 1024 / 1024).toFixed(0)} MB，而 era 每个节点都要完整复制一份。` +
        `把数据挪到 seed 外面（评测脚本用绝对路径引用），或写进 .era-hidden。`,
    );
  }

  return {
    checks,
    baseline,
    // Only the unparseable-score case is fatal: it fails 100% of the time.
    canStart: baseline !== null,
    notes,
  };
}
