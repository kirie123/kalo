/**
 * Discovering and starting runs.
 *
 * A "workspace" is a directory the wizard (or the user) filled with a seed and
 * an `era-run.json`. Runs live under `<workspace>/era-runs/<name>/`, which is
 * where era writes `trace.jsonl`, `tree.json` and the node workspaces.
 *
 * Discovery is filesystem-only, on purpose: a run directory is self-describing
 * (it has a `trace.jsonl` or it does not), so a deleted directory simply stops
 * appearing and there is no registry to go stale. The only thing kept in
 * localStorage is the list of workspaces the user has opened.
 */

import { appPaths, dirDiffNames, jobList, jobStart, listDir, readFileText } from "../../lib/pi-bridge";
import type { BackgroundJob, DirEntry } from "../../types";
import { EraFolder } from "./fold";
import type { EraTree } from "./types";
import { buildServeCommand, parseSpec, type EraRunSpec } from "./spec";

const WORKSPACES_KEY = "kalo.era.workspaces";
export const RUNS_SUBDIR = "era-runs";
export const SPEC_FILE = "era-run.json";
export const TRACE_FILE = "trace.jsonl";

/** Job kind prefix for era runs, so they are recognisable in the job list. */
export const ERA_JOB_KIND = "era";

// ---------------------------------------------------------------- workspaces

/** Workspaces the user has opened, most recent first. */
export function loadWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberWorkspace(dir: string): string[] {
  const next = [dir, ...loadWorkspaces().filter((d) => d !== dir)].slice(0, 20);
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(next));
  return next;
}

export function forgetWorkspace(dir: string): string[] {
  const next = loadWorkspaces().filter((d) => d !== dir);
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------- runs

export interface EraRunRef {
  /** Absolute path of the run's output directory. */
  dir: string;
  name: string;
  workspace: string;
  /** Absolute path of `trace.jsonl`. */
  tracePath: string;
  modifiedMs: number;
}

/** Every run directory under a workspace that has a trace to read. */
export async function listRuns(workspace: string): Promise<EraRunRef[]> {
  let entries: DirEntry[];
  try {
    entries = await listDir(`${workspace}/${RUNS_SUBDIR}`);
  } catch {
    // No runs directory yet is the normal state for a fresh workspace.
    return [];
  }
  const out: EraRunRef[] = [];
  for (const e of entries) {
    if (!e.isDir) continue;
    // A directory without a trace is not a run: it may be a half-created
    // output dir, or something the user put there. Skip it silently.
    const trace = `${e.path}/${TRACE_FILE}`;
    const probe = await readFileText(trace, 1).catch(() => null);
    if (probe === null) continue;
    out.push({
      dir: e.path,
      name: e.name,
      workspace,
      tracePath: trace,
      modifiedMs: e.modifiedMs,
    });
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return out;
}

/**
 * Fold a whole trace file in one pass. Used for the list view, where only the
 * summary numbers matter; the detail view keeps a live folder instead.
 */
export async function foldRunOnce(tracePath: string): Promise<EraTree> {
  const folder = new EraFolder();
  const text = await readFileText(tracePath, 8 * 1024 * 1024).catch(() => null);
  if (text) folder.push(text.text);
  return folder.snapshot();
}

/** Read and parse a workspace's `era-run.json`. */
export async function readSpec(workspace: string): Promise<
  { ok: true; spec: EraRunSpec; text: string } | { ok: false; error: string; text: string }
> {
  const file = await readFileText(`${workspace}/${SPEC_FILE}`, 256 * 1024).catch(() => null);
  if (!file) {
    return { ok: false, error: `没有找到 ${SPEC_FILE}`, text: "" };
  }
  const parsed = parseSpec(file.text);
  return parsed.ok
    ? { ok: true, spec: parsed.spec, text: file.text }
    : { ok: false, error: parsed.error, text: file.text };
}

/** Read a workspace's `.era-fixtures`, if the seed has one. */
export async function readFixtures(
  seedDir: string,
): Promise<{ present: boolean; entries: string[] }> {
  const file = await readFileText(`${seedDir}/.era-fixtures`, 64 * 1024).catch(() => null);
  if (!file) return { present: false, entries: [] };
  const entries = file.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/\\/g, "/"));
  return { present: true, entries };
}

export interface StartRunResult {
  jobId: string;
  outDir: string;
  /** The exact command line, so the UI can offer "copy command". */
  cmd: string;
}

/**
 * Start a run as an ordinary background command job.
 *
 * The output directory must not exist — era refuses a non-empty one, and
 * silently reusing a directory would interleave two runs' traces into one
 * unfoldable file.
 */
export async function startRun(workspace: string, spec: EraRunSpec): Promise<StartRunResult> {
  const paths = await appPaths();
  if (!paths.engineBin) {
    throw new Error("找不到 kalo 自带的引擎程序（pi），无法把 --agent-bin 指过去");
  }
  const outDir = `${workspace}/${RUNS_SUBDIR}/${spec.name}`;
  const existing = await readFileText(`${outDir}/${TRACE_FILE}`, 1).catch(() => null);
  if (existing !== null) {
    throw new Error(`${outDir} 已经有一次运行的记录了，换个名字`);
  }
  const seedDir = spec.seed.match(/^([A-Za-z]:[\\/]|\/)/) ? spec.seed : `${workspace}/${spec.seed}`;
  const cmd = buildServeCommand(spec, {
    outDir,
    seedDir,
    agentBin: paths.engineBin,
    eraBin: spec.eraBin ?? undefined,
  });
  const jobId = await jobStart({
    label: `演化 ${spec.name}`,
    cwd: workspace,
    cmd,
    kind: ERA_JOB_KIND,
  });
  return { jobId, outDir, cmd };
}

/** The background job backing a run, matched by its label. */
export async function findRunJob(runName: string): Promise<BackgroundJob | null> {
  const jobs = await jobList().catch(() => [] as BackgroundJob[]);
  const label = `演化 ${runName}`;
  // Newest first: a re-run of the same name should surface the live one.
  const matches = jobs.filter((j) => j.label === label).sort((a, b) => b.startedAt - a.startedAt);
  return matches[0] ?? null;
}

/**
 * Files that differ between a node's workspace and its parent's — the answer
 * to "what did this mutation actually change".
 */
export async function nodeDiffNames(
  runDir: string,
  parentPath: string | null,
  nodePath: string,
): Promise<{ changed: string[]; added: string[]; removed: string[]; truncated?: boolean; error?: string }> {
  if (!parentPath) return { changed: [], added: [], removed: [], error: "这是种子节点，没有父节点可比" };
  try {
    // `.era` is era's own per-node bookkeeping; it differs for every node and
    // would drown the real change in noise.
    const diff = await dirDiffNames(`${runDir}/${parentPath}`, `${runDir}/${nodePath}`, [
      ".era",
      "__pycache__",
      ".git",
      "node_modules",
    ]);
    return { changed: diff.changed, added: diff.added, removed: diff.removed, truncated: diff.truncated };
  } catch (e) {
    return {
      changed: [],
      added: [],
      removed: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
