/**
 * Run the eval command the way era will, and report what happened.
 *
 * This is what makes the gate mechanical rather than advisory: it does not
 * inspect the eval, it *runs* it — on a pristine copy of the seed, in a
 * throwaway directory, capturing stdout and stderr separately and recording
 * the exit code. Whatever it reports is what era would have seen.
 *
 * It uses the ordinary command-job runtime; no new process management. The
 * separation of stdout from stderr is done with explicit shell redirects,
 * because a job's own log is `2>&1` into one file and the score is defined as
 * "the last line of **stdout**".
 */

import { jobList, jobStart, jobStop, readFileText } from "../../lib/pi-bridge";
import type { EvalProbe } from "./gate";
import { shq } from "./spec";
import { isJobTerminal } from "../../types";

/** Where the probe scratch lives, relative to the workspace directory. */
export const PROBE_DIR = ".era-gate";

export interface ProbeRequest {
  /** Directory that holds the seed and receives `.era-gate/`. */
  workDir: string;
  /** Absolute path to the seed directory. */
  seedDir: string;
  /** The `--eval` command, run inside a copy of the seed. */
  evalCmd: string;
  /** Run it twice, in two independent copies, for the determinism check. */
  twice: boolean;
  /** Give up after this many seconds and kill the job. */
  timeoutS: number;
}

export interface ProbeResult {
  first: EvalProbe;
  second?: EvalProbe;
  /** Absolute path of the scratch dir, so the UI can offer "open folder". */
  probeDir: string;
}

/**
 * The shell program the probe job runs.
 *
 * Notes that matter:
 * - The seed is **copied**, never evaluated in place: an eval that writes
 *   artefacts would otherwise pollute the seed that every node is cloned from.
 * - `cp -r <seed>/. <dst>/` copies dotfiles too, which includes the
 *   `.era-fixtures` manifest the checks read.
 * - The exit code is written to a file rather than inferred, because the job
 *   runtime reports the exit status of the whole script, not of the eval.
 */
function probeScript(req: ProbeRequest, probeDir: string): string {
  const one = (n: number) => {
    const dir = `${probeDir}/run${n}`;
    return [
      `rm -rf ${shq(dir)}`,
      `mkdir -p ${shq(dir)}`,
      `cp -r ${shq(req.seedDir)}/. ${shq(dir)}/`,
      `cd ${shq(dir)}`,
      `{ ${req.evalCmd} ; } > ${shq(`${dir}/.stdout`)} 2> ${shq(`${dir}/.stderr`)}`,
      `echo $? > ${shq(`${dir}/.exit`)}`,
    ].join("\n");
  };
  const parts = [`mkdir -p ${shq(probeDir)}`, one(1)];
  if (req.twice) parts.push(one(2));
  parts.push(`echo done > ${shq(`${probeDir}/.finished`)}`);
  return parts.join("\n");
}

async function readProbe(dir: string, elapsedS: number): Promise<EvalProbe> {
  const [out, err, code] = await Promise.all([
    readFileText(`${dir}/.stdout`, 256 * 1024).catch(() => null),
    readFileText(`${dir}/.stderr`, 256 * 1024).catch(() => null),
    readFileText(`${dir}/.exit`, 64).catch(() => null),
  ]);
  if (out === null && code === null) {
    return {
      stdout: "",
      stderr: err?.text ?? "",
      exitCode: null,
      durationS: elapsedS,
      launchError: "评测没有产生任何输出（命令可能根本没跑起来）",
    };
  }
  const parsed = Number((code?.text ?? "").trim());
  return {
    stdout: out?.text ?? "",
    stderr: err?.text ?? "",
    exitCode: Number.isFinite(parsed) ? parsed : null,
    durationS: elapsedS,
  };
}

/**
 * Run the probe and wait for it. Rejects only when the job could not be
 * started at all (no gateway); an eval that fails is a *result*, not an error.
 */
export async function runEvalProbe(req: ProbeRequest): Promise<ProbeResult> {
  const probeDir = `${req.workDir}/${PROBE_DIR}`;
  const startedAt = Date.now();
  const id = await jobStart({
    label: `验证评测 · ${req.evalCmd}`,
    cwd: req.workDir,
    cmd: probeScript(req, probeDir),
    kind: "eragate",
  });

  const deadline = startedAt + req.timeoutS * 1000;
  let timedOut = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 600));
    const jobs = await jobList().catch(() => []);
    const job = jobs.find((j) => j.id === id);
    if (job && isJobTerminal(job.status)) break;
    if (Date.now() > deadline) {
      timedOut = true;
      await jobStop(id, "验证超时").catch(() => undefined);
      break;
    }
  }

  const elapsedS = (Date.now() - startedAt) / 1000;
  const first = await readProbe(`${probeDir}/run1`, elapsedS);
  const result: ProbeResult = { first, probeDir };
  if (timedOut && !first.stdout) {
    result.first = {
      ...first,
      launchError: `超过 ${req.timeoutS}s 还没跑完，已中止`,
    };
  }
  if (req.twice) {
    result.second = await readProbe(`${probeDir}/run2`, elapsedS);
  }
  return result;
}
