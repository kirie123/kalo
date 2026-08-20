/**
 * The one-click example experiment.
 *
 * The hardest part of trying evolution is not `--budget 20`; it is that you
 * need a seed program, a scoring script whose last stdout line is a float, and
 * a task worth searching — before you have ever seen the thing work. The
 * wizard builds those from a conversation, which is the right answer for real
 * work and the wrong one for "does this feature do anything".
 *
 * So: a complete experiment, written to disk in one click, with nothing to
 * fill in. It is deliberately a *real* one — the same TSP task era ships as
 * its acceptance example — because the point is to show the score climb, and
 * a task with no head-room shows nothing.
 *
 * The files are copies of `examples/toy/seed/` from era-evolve (MIT, same
 * author). They live here rather than being read out of an era checkout for
 * the obvious reason: someone who just cloned kalo does not have one.
 */

import { appPaths, jobList, jobStart, listDir } from "../../lib/pi-bridge";
import { isJobTerminal } from "../../types";
import { shq } from "./spec";

import EVAL_PY from "./example/eval.py?raw";
import SOLUTION_PY from "./example/solution.py?raw";
import FIXTURES from "./example/era-fixtures.txt?raw";

/** Directory name, also the run name inside it. */
export const EXAMPLE_NAME = "tsp60";

/**
 * Budget is 8 rather than era's default 20 on purpose. Every expansion is a
 * real model call against the user's own credentials, and this is the button
 * someone presses to find out what the feature *is*. Eight is enough to see
 * the curve move — the first mutation on this task usually goes from "visit
 * the cities in the order given" (≈ −32900) to a nearest-neighbour tour
 * (≈ −6900), which is not a subtle change.
 */
export const EXAMPLE_BUDGET = 8;

const SPEC = {
  version: 1,
  name: EXAMPLE_NAME,
  task:
    "改进 solve()：给定平面上的一组城市坐标，返回一条更短的巡回路线（城市索引的排列）。" +
    "可以用最近邻构造、2-opt / Or-opt 局部搜索等启发式，只要在时间上限内跑完。",
  seed: "seed",
  eval: "python eval.py",
  metricGoal: "max",
  budget: EXAMPLE_BUDGET,
  evalTimeout: 120,
  maxSteps: 20,
  evalRepeats: 1,
  evolves: ["solution.py"],
  scoreMeaning:
    "分数 = 8 个固定实例上平均巡回长度的相反数，越大越好。" +
    "初始的「按给定顺序访问」约 -32900，最近邻约 -6900，2-opt 还能更好。",
};

/**
 * Emit a file with a quoted heredoc, so nothing in the content is expanded by
 * the shell. `\n` before the terminator guards against a file that does not
 * end in a newline.
 */
function writeFile(path: string, content: string): string {
  return [`cat > ${shq(path)} <<'KALO_ERA_EOF'`, content.replace(/\r\n/g, "\n").replace(/\n$/, ""), "KALO_ERA_EOF"].join(
    "\n",
  );
}

export interface ExampleResult {
  /** The workspace directory, ready to be opened in the panel. */
  workspace: string;
  /** True when it already existed and was left untouched. */
  reused: boolean;
}

/** Where the example lands. Under `~/.kalo` so it needs no directory picker. */
export async function exampleDir(): Promise<string> {
  const paths = await appPaths();
  return `${paths.kaloRoot}/era-examples/${EXAMPLE_NAME}`;
}

/**
 * Write the example experiment to disk.
 *
 * An existing directory is **reused, never overwritten**: the user may have
 * edited the eval or already run against it, and silently replacing that would
 * throw away work in the one flow that is supposed to be safe to press.
 */
export async function createExample(): Promise<ExampleResult> {
  const workspace = await exampleDir();
  const already = await listDir(workspace).catch(() => null);
  if (already && already.length > 0) return { workspace, reused: true };

  const seed = `${workspace}/seed`;
  const script = [
    `mkdir -p ${shq(seed)}`,
    writeFile(`${seed}/eval.py`, EVAL_PY),
    writeFile(`${seed}/solution.py`, SOLUTION_PY),
    writeFile(`${seed}/.era-fixtures`, FIXTURES),
    writeFile(`${workspace}/era-run.json`, `${JSON.stringify(SPEC, null, 2)}\n`),
  ].join("\n");

  const paths = await appPaths();
  const id = await jobStart({
    label: "创建示例实验",
    cwd: paths.kaloRoot || paths.home,
    cmd: script,
    kind: "eraexample",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const jobs = await jobList().catch(() => []);
    const job = jobs.find((j) => j.id === id);
    if (job && isJobTerminal(job.status)) break;
    if (Date.now() > deadline) throw new Error("创建示例超时");
  }

  // Trust nothing: confirm the spec is actually on disk before telling the
  // panel to open a workspace.
  const entries = await listDir(workspace).catch(() => []);
  if (!entries.some((e) => e.name === "era-run.json")) {
    throw new Error(`示例没有写成功，${workspace} 里没有 era-run.json`);
  }
  return { workspace, reused: false };
}
