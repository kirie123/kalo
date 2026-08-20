/**
 * Finding era, and finding a Python that can actually run an eval script.
 *
 * Why this file exists at all: era is a *separate* repository, and the thing
 * that decides whether a fresh clone of kalo can run an evolution is not
 * "is era installed" — era is pure stdlib with an `era/__main__.py`, so
 * `PYTHONPATH=<checkout> python -m era` works with no pip, no venv, no pipx.
 * The thing that actually decides it is **which interpreter you get**, and the
 * three normal ways of asking that question all lie on a typical machine:
 *
 *   - `python` on PATH may be a 2.x left over from years ago
 *   - the `py` launcher only reports interpreters it registered
 *   - a perfectly healthy conda/miniforge 3.12 is reported by neither
 *
 * That is not a hypothetical. On the machine this was written on, all three
 * hold at once, and the same trap made era's own test suite red, era's own
 * examples unrunnable, and one kalo run finish in 1.5s with zero nodes.
 *
 * So: probe everything once, keep only interpreters that are >=3.10 and not a
 * prerelease, and remember the absolute path. The location is a **machine-level**
 * fact — it lives in localStorage, not in `era-run.json`, because a run spec
 * travels between machines and gets rewritten by the wizard, while "where is
 * python on this laptop" does not travel anywhere.
 */

import { appPaths, jobList, jobStart, jobStop, readFileText } from "../../lib/pi-bridge";
import { isJobTerminal } from "../../types";
import { shq } from "./spec";

/** Explicit override: a command that runs era (`era`, or a full path). */
const BIN_KEY = "kalo.era.bin";
/** Explicit override: a checkout of the era-evolve repository. */
const SRC_KEY = "kalo.era.source";
/** Explicit override: an interpreter to run eval commands with. */
const PY_KEY = "kalo.era.python";

/** Lowest interpreter era supports; mirrors `requires-python` in its pyproject. */
export const MIN_PY: [number, number] = [3, 10];

export function loadEraBin(): string {
  return localStorage.getItem(BIN_KEY)?.trim() ?? "";
}
export function saveEraBin(v: string): void {
  const t = v.trim();
  if (t) localStorage.setItem(BIN_KEY, t);
  else localStorage.removeItem(BIN_KEY);
  invalidate();
}

export function loadEraSource(): string {
  return localStorage.getItem(SRC_KEY)?.trim() ?? "";
}
export function saveEraSource(v: string): void {
  const t = v.trim();
  if (t) localStorage.setItem(SRC_KEY, t);
  else localStorage.removeItem(SRC_KEY);
  invalidate();
}

export function loadPythonOverride(): string {
  return localStorage.getItem(PY_KEY)?.trim() ?? "";
}
export function savePythonOverride(v: string): void {
  const t = v.trim();
  if (t) localStorage.setItem(PY_KEY, t);
  else localStorage.removeItem(PY_KEY);
  invalidate();
}

// -------------------------------------------------------------- probe result

export interface PythonInfo {
  path: string;
  /** `[major, minor, micro]`. */
  version: [number, number, number];
  /** `final`, `alpha`, `beta`, `candidate`. */
  releaseLevel: string;
}

/** Everything one sweep of the machine found. */
export interface EraProbe {
  /** `era` executables on PATH. */
  eraOnPath: string[];
  /** `era` installed by `uv tool install` (its bin dir is not always on PATH). */
  eraFromUv: string[];
  /** `uv` itself, if present — the installer card needs to know. */
  uv: string | null;
  /** Every interpreter found, usable or not, so the UI can explain a rejection. */
  pythons: PythonInfo[];
  /** Directories that look like an era-evolve checkout. */
  sources: string[];
  /** Raw report text, for the "看探测结果" disclosure. */
  raw: string;
}

/** How era will be invoked, and with what. */
export interface EraLocation {
  /** Command prefix that runs era. Already quoted; prepend to `serve`/`doctor`. */
  cmd: string;
  via: "setting" | "spec" | "path" | "uv" | "source";
  /**
   * Absolute interpreter path, when one is known. This is *also* what eval
   * commands get rewritten to use — see `withPython`.
   */
  python: string | null;
  /** One line, shown next to the run button so a surprising pick is visible. */
  detail: string;
}

export type EraResolution =
  | { ok: true; location: EraLocation; probe: EraProbe }
  | { ok: false; reason: string; probe: EraProbe };

// ------------------------------------------------------------------ probing

interface Captured {
  out: string;
  err: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run a shell script as an ordinary background job and collect its output.
 *
 * stdout, stderr and the exit code go to three separate files rather than
 * being read back from the job log: a job's own log is `2>&1` into one file,
 * and both callers here care about the distinction (a doctor failure is
 * judged on the exit code, and its stderr is what gets shown to the user).
 */
async function capture(opts: {
  label: string;
  cwd: string;
  scratch: string;
  script: string;
  timeoutS: number;
  kind: string;
}): Promise<Captured> {
  const script = [
    `rm -rf ${shq(opts.scratch)}`,
    `mkdir -p ${shq(opts.scratch)}`,
    `{ ${opts.script}`,
    `} > ${shq(`${opts.scratch}/.out`)} 2> ${shq(`${opts.scratch}/.err`)}`,
    `echo $? > ${shq(`${opts.scratch}/.exit`)}`,
  ].join("\n");

  const startedAt = Date.now();
  const id = await jobStart({ label: opts.label, cwd: opts.cwd, cmd: script, kind: opts.kind });

  const deadline = startedAt + opts.timeoutS * 1000;
  let timedOut = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const jobs = await jobList().catch(() => []);
    const job = jobs.find((j) => j.id === id);
    if (job && isJobTerminal(job.status)) break;
    if (Date.now() > deadline) {
      timedOut = true;
      await jobStop(id, "探测超时").catch(() => undefined);
      break;
    }
  }

  const [out, err, code] = await Promise.all([
    readFileText(`${opts.scratch}/.out`, 256 * 1024).catch(() => null),
    readFileText(`${opts.scratch}/.err`, 256 * 1024).catch(() => null),
    readFileText(`${opts.scratch}/.exit`, 64).catch(() => null),
  ]);
  const parsed = Number((code?.text ?? "").trim());
  return {
    out: out?.text ?? "",
    err: err?.text ?? "",
    code: Number.isFinite(parsed) && (code?.text ?? "").trim() !== "" ? parsed : null,
    timedOut,
  };
}

/**
 * The sweep. One job, one report, because each of these questions costs a
 * process launch and asking them one at a time would take seconds.
 *
 * Every candidate interpreter is *executed* rather than judged by its path:
 * a directory named `Python310` proves nothing, and `python -c` works on 2.7
 * too, so a 2.x is detected and rejected rather than silently misread.
 */
function probeScript(sourceHint: string): string {
  return String.raw`
hint=${shq(sourceHint)}

emit() { printf '%s\t%s\n' "$1" "$2"; }

for p in "$HOME/.local/bin/era" "$HOME/.local/bin/era.exe"; do
  [ -x "$p" ] && emit UVERA "$p"
done
p="$(command -v era 2>/dev/null)"; [ -n "$p" ] && emit ERA "$p"
p="$(command -v uv 2>/dev/null)"; [ -n "$p" ] && emit UV "$p"

cands=""
add() { [ -n "$1" ] && cands="$cands
$1"; }

# Assigned rather than used inline: this is a JS template literal, so a shell
# "$" followed by a brace would be read as an interpolation before bash ever
# sees it. Every expansion below is therefore the brace-less form.
lad="$LOCALAPPDATA"
[ -n "$lad" ] || lad=/nonexistent

for c in python3 python; do
  add "$(command -v "$c" 2>/dev/null)"
done

# The py launcher lists what it registered; the path is whatever follows the
# run of spaces after the version tag, so a path with spaces survives.
if command -v py >/dev/null 2>&1; then
  while IFS= read -r line; do
    add "$(printf '%s' "$line" | sed -n 's/^.*[[:space:]]\{2,\}\(.*\)$/\1/p')"
  done <<EOF
$(py -0p 2>/dev/null)
EOF
fi

# uv keeps its managed interpreters outside PATH on purpose.
if command -v uv >/dev/null 2>&1; then
  add "$(uv python find '>=3.10' 2>/dev/null)"
fi

# conda/miniforge/mamba and the usual per-user installers, none of which are
# guaranteed to be on PATH or known to the py launcher.
for p in \
  "$HOME/miniforge3/python.exe" "$HOME/miniconda3/python.exe" "$HOME/anaconda3/python.exe" \
  "$HOME/mambaforge/python.exe" \
  "$HOME/miniforge3/bin/python3" "$HOME/miniconda3/bin/python3" "$HOME/anaconda3/bin/python3" \
  "$HOME/mambaforge/bin/python3" \
  "$lad/Programs/Python"/Python3*/python.exe \
  /c/Python3*/python.exe "/c/Program Files/Python3"*/python.exe \
  /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 ; do
  [ -x "$p" ] && add "$p"
done

printf '%s\n' "$cands" | sort -u | while IFS= read -r p; do
  [ -n "$p" ] || continue
  v="$("$p" -c 'import sys;print("%d.%d.%d %s"%(sys.version_info[0],sys.version_info[1],sys.version_info[2],sys.version_info.releaselevel))' 2>/dev/null)"
  [ -n "$v" ] && emit PY "$p	$v"
done

for d in "$hint" "$HOME/era-evolve" "$HOME/project/era-evolve" "$HOME/projects/era-evolve" "$HOME/src/era-evolve"; do
  [ -n "$d" ] && [ -f "$d/era/__main__.py" ] && emit SRC "$d"
done
exit 0
`;
}

export function parseProbe(raw: string): EraProbe {
  const probe: EraProbe = { eraOnPath: [], eraFromUv: [], uv: null, pythons: [], sources: [], raw };
  for (const line of raw.split(/\r?\n/)) {
    const [tag, ...rest] = line.split("\t");
    const value = rest.join("\t").trim();
    if (!value) continue;
    if (tag === "ERA") probe.eraOnPath.push(value);
    else if (tag === "UVERA") probe.eraFromUv.push(value);
    else if (tag === "UV") probe.uv = value;
    else if (tag === "SRC") probe.sources.push(value);
    else if (tag === "PY") {
      // `<path>\t<major.minor.micro> <releaselevel>`
      const tab = value.lastIndexOf("\t");
      if (tab < 0) continue;
      const path = value.slice(0, tab).trim();
      const [ver, level = "final"] = value.slice(tab + 1).trim().split(/\s+/);
      const parts = ver.split(".").map((n) => Number(n));
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) continue;
      probe.pythons.push({
        path,
        version: [parts[0], parts[1], parts[2]],
        releaseLevel: level,
      });
    }
  }
  // Dedupe: the same interpreter is often reachable by several routes.
  const seen = new Set<string>();
  probe.pythons = probe.pythons.filter((p) => {
    const k = p.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return probe;
}

/** Usable interpreters, best first. Prereleases and <3.10 are excluded. */
export function usablePythons(probe: EraProbe): PythonInfo[] {
  return probe.pythons
    .filter((p) => p.releaseLevel === "final")
    .filter((p) => p.version[0] > MIN_PY[0] || (p.version[0] === MIN_PY[0] && p.version[1] >= MIN_PY[1]))
    .sort((a, b) => b.version[1] - a.version[1] || b.version[2] - a.version[2]);
}

export function formatPython(p: PythonInfo): string {
  const v = p.version.join(".");
  return p.releaseLevel === "final" ? v : `${v}${p.releaseLevel[0]}`;
}

// ----------------------------------------------------------------- resolving

let cached: { probe: EraProbe; at: number } | null = null;
let inflight: Promise<EraProbe> | null = null;

/** Forget the sweep. Called after an install, or when a setting changes. */
export function invalidate(): void {
  cached = null;
}

export async function probeMachine(force = false): Promise<EraProbe> {
  if (!force && cached) return cached.probe;
  if (!force && inflight) return inflight;
  const run = (async () => {
    const paths = await appPaths();
    const cwd = paths.kaloRoot || paths.home;
    const res = await capture({
      label: "探测 era 环境",
      cwd,
      scratch: `${paths.kaloRoot}/.era-locate`,
      script: probeScript(loadEraSource()),
      timeoutS: 45,
      kind: "eralocate",
    });
    const probe = parseProbe(res.out);
    cached = { probe, at: Date.now() };
    return probe;
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    inflight = null;
  }
}

/**
 * Just the interpreter, without requiring era to be present.
 *
 * The eval probe needs this: it runs the scoring command, which has nothing to
 * do with era being installed, and refusing to probe an eval because era is
 * missing would hide the very check that explains why the eval is broken.
 */
export async function resolvePython(force = false): Promise<PythonInfo | null> {
  const probe = await probeMachine(force);
  const override = loadPythonOverride();
  if (override) {
    const known = probe.pythons.find((p) => p.path.toLowerCase() === override.toLowerCase());
    return known ?? { path: override, version: [0, 0, 0], releaseLevel: "final" };
  }
  return usablePythons(probe)[0] ?? null;
}

/**
 * Decide how to run era.
 *
 * The order is deliberate: anything the user said explicitly wins over anything
 * discovered, and a discovered *installation* wins over running from a source
 * checkout — a checkout is the developer's case, and quietly preferring it
 * would mean a `git pull` in another repository can change what kalo runs.
 *
 * `specEraBin` is the read-only compatibility path for run specs written before
 * the setting existed. Nothing writes that field any more.
 */
export async function resolveEra(specEraBin?: string | null, force = false): Promise<EraResolution> {
  const probe = await probeMachine(force);
  const pythons = usablePythons(probe);
  const override = loadPythonOverride();
  const python = override || (pythons[0]?.path ?? null);

  const setting = loadEraBin();
  if (setting) {
    return {
      ok: true,
      probe,
      location: { cmd: shq(setting), via: "setting", python, detail: `使用设置里指定的 ${setting}` },
    };
  }
  if (specEraBin && specEraBin.trim()) {
    const v = specEraBin.trim();
    return {
      ok: true,
      probe,
      location: { cmd: shq(v), via: "spec", python, detail: `使用 era-run.json 里的 eraBin：${v}` },
    };
  }
  if (probe.eraOnPath.length > 0) {
    return {
      ok: true,
      probe,
      location: { cmd: "era", via: "path", python, detail: `PATH 上的 era（${probe.eraOnPath[0]}）` },
    };
  }
  if (probe.eraFromUv.length > 0) {
    const p = probe.eraFromUv[0];
    return {
      ok: true,
      probe,
      location: { cmd: shq(p), via: "uv", python, detail: `uv 安装的 era（${p}）` },
    };
  }
  if (probe.sources.length > 0 && pythons.length > 0) {
    const src = probe.sources[0];
    const py = pythons[0];
    // No install step: era is pure stdlib and has `era/__main__.py`, so a
    // checkout on PYTHONPATH is a complete, runnable era.
    return {
      ok: true,
      probe,
      location: {
        cmd: `PYTHONPATH=${shq(src)} ${shq(py.path)} -m era`,
        via: "source",
        python: override || py.path,
        detail: `源码检出 ${src}（Python ${formatPython(py)}）`,
      },
    };
  }

  if (probe.sources.length > 0) {
    return { ok: false, probe, reason: `找到了 era 源码（${probe.sources[0]}），但没有 ≥3.10 的 Python 可以跑它` };
  }
  return { ok: false, probe, reason: "这台机器上没有找到 era" };
}

// ------------------------------------------------------------ eval rewriting

/** A bare interpreter name at the head of a command — the thing that lies. */
const BARE_PY = /^(python3?|py)(\.exe)?$/i;

/**
 * Point an eval command at a known-good interpreter.
 *
 * This is not the same problem as finding era, and installing era does not fix
 * it: `--eval` is a shell command era *spawns*, so a bare `python` in it is
 * resolved against PATH at that moment — the same PATH whose `python` is 2.7.
 * era running on a healthy 3.12 will still score every candidate with 2.7 and
 * report that nothing ever improved.
 *
 * Only a bare leading token is rewritten. Anything with a slash is a path the
 * user chose, and anything more complicated than `python …` is left alone —
 * the eval probe's warning covers those rather than a guess doing it silently.
 */
export function withPython(evalCmd: string, python: string | null): string {
  if (!python) return evalCmd;
  const m = evalCmd.match(/^\s*(\S+)([\s\S]*)$/);
  if (!m) return evalCmd;
  const head = m[1];
  if (head.includes("/") || head.includes("\\") || head.startsWith("'") || head.startsWith('"')) return evalCmd;
  if (!BARE_PY.test(head)) return evalCmd;
  return `${shq(python)}${m[2]}`;
}

/** Whether `withPython` would change anything — used to explain the rewrite. */
export function rewritesPython(evalCmd: string): boolean {
  const m = evalCmd.match(/^\s*(\S+)/);
  return !!m && BARE_PY.test(m[1]);
}

// --------------------------------------------------------------- preflight

export interface DoctorResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
  cmd: string;
}

/**
 * `era doctor` before spending anything.
 *
 * `--agent-bin` is not optional here: without it era falls back to its own
 * lookup and would check some other pi (or none) instead of the one kalo
 * ships, which is exactly the mismatch this is meant to catch.
 *
 * The verdict is "non-zero blocks". era distinguishes its failures by code
 * (a missing engine is 2, an engine that will not probe is 1), but that split
 * is era's business — depending on it here would make kalo's gate a mirror of
 * era's internals rather than of the question being asked.
 */
export async function runDoctor(location: EraLocation, agentBin: string): Promise<DoctorResult> {
  const paths = await appPaths();
  const cmd = `${location.cmd} doctor --agent-bin ${shq(agentBin)}`;
  const res = await capture({
    label: "自检 era",
    cwd: paths.kaloRoot || paths.home,
    scratch: `${paths.kaloRoot}/.era-doctor`,
    script: cmd,
    timeoutS: 60,
    kind: "eradoctor",
  });
  if (res.timedOut) {
    return { ok: false, code: null, out: res.out, err: `${res.err}\n自检超过 60s 没有返回，已中止。`, cmd };
  }
  return { ok: res.code === 0, code: res.code, out: res.out, err: res.err, cmd };
}
