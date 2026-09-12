#!/usr/bin/env node
/**
 * Pre-dev/build guard: make sure the pi engine and kalo-gateway sidecars are
 * staged into kalo-desktop/src-tauri/binaries/ before `tauri dev|build`.
 * (The Tauri build script hard-fails when bundle resources are missing.)
 *
 * Fast path: binaries present → exits immediately.
 * Slow path (first run, or FORCE_ENGINE_BUILD=1):
 *   1. install kalo-harness dependencies if node_modules is missing
 *   2. scripts/build-engine.sh  → engine + runtime resources
 *   3. scripts/build-gateway.sh → gateway sidecar
 *
 * Run via bun at the repo root: `bun scripts/ensure-engine.mjs`
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BINARIES = join(ROOT, "kalo-desktop", "src-tauri", "binaries");
const HARNESS = join(ROOT, "kalo-harness");
const GATEWAY_DIR = join(ROOT, "kalo-desktop", "gateway");

const IS_WIN = process.platform === "win32";
const FORCE = !!process.env.FORCE_ENGINE_BUILD;

function run(cmd, args, cwd, useShell = false) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd, shell: useShell });
  if (res.status !== 0) {
    console.error(`[ensure-engine] command failed (${res.status}): ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

/** Same as run(), but a failure is reported and swallowed. */
function runSoft(cmd, args, cwd, useShell = false) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd, shell: useShell });
  return res.status === 0;
}

/**
 * Locate a usable bash for build-engine.sh. On Windows prefer an explicit
 * Git Bash path: the `bash` on PATH is often WSL's, which cannot run the
 * script. Override with KALO_BASH / BASH if your layout differs.
 */
function findBash() {
  const candidates = [
    process.env.KALO_BASH,
    process.env.BASH,
    IS_WIN && "C:\\Program Files\\Git\\bin\\bash.exe",
    IS_WIN && "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return { cmd: c, shell: false };
  }
  return { cmd: "bash", shell: false }; // PATH lookup (macOS / Linux / Git-Bash-first PATH)
}

/**
 * Ask scripts/platform.sh for this platform's sidecar naming, so the staleness
 * check looks for exactly the files the build scripts produce. Hard-coding the
 * names here would reintroduce the bug this whole naming scheme exists to
 * prevent: on a foreign platform the check passes on a binary that cannot run
 * (or fails on one that was just built successfully).
 */
function sidecarNames() {
  const bash = findBash();
  const res = spawnSync(
    bash.cmd,
    ["-c", 'source "$0/scripts/platform.sh" && kalo_platform_init && printf "%s\\n%s\\n" "$KALO_TRIPLE" "$KALO_EXE_SUFFIX"', ROOT],
    { cwd: ROOT, shell: bash.shell, encoding: "utf8" },
  );
  if (res.status !== 0) {
    console.error("[ensure-engine] cannot resolve target platform via scripts/platform.sh");
    console.error(res.stderr ?? "");
    process.exit(res.status ?? 1);
  }
  const [triple = "", suffix = ""] = res.stdout.split("\n");
  return {
    pi: join(BINARIES, `pi-${triple}${suffix}`),
    gateway: join(BINARIES, `kalo-gateway-${triple}${suffix}`),
  };
}

const { pi: PI_EXE, gateway: GATEWAY_EXE } = sidecarNames();

const newerThan = (file, reference) => statSync(file).mtimeMs > statSync(reference).mtimeMs;

/** True when any file under `dir` (recursively) is newer than `cutoffMs`. */
function newerThanIn(dir, cutoffMs) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (newerThanIn(p, cutoffMs)) return true;
    } else if (statSync(p).mtimeMs > cutoffMs) {
      return true;
    }
  }
  return false;
}

/**
 * Pi engine rebuild triggers on a missing exe or changed harness sources:
 * any file under kalo-harness/packages/<pkg>/src newer than the staged exe.
 * Without this, engine-side fixes never reach `tauri dev` until a manual
 * build-engine.sh.
 */
function engineStale() {
  if (!existsSync(PI_EXE)) return true;
  const packagesDir = join(HARNESS, "packages");
  let pkgs;
  try {
    pkgs = readdirSync(packagesDir);
  } catch {
    return true;
  }
  const cutoff = statSync(PI_EXE).mtimeMs;
  for (const pkg of pkgs) {
    const src = join(packagesDir, pkg, "src");
    if (existsSync(src) && newerThanIn(src, cutoff)) return true;
  }
  return false;
}

/**
 * Gateway rebuild is cheap: trigger on missing exe or changed sources. The
 * source scan must recurse — src/jobs/ alone holds most of the gateway, and a
 * top-level-only check let edits in there ship a stale sidecar to both
 * `tauri dev` and `tauri build`.
 */
function gatewayStale() {
  if (!existsSync(GATEWAY_EXE)) return true;
  const srcDir = join(GATEWAY_DIR, "src");
  if (existsSync(srcDir) && newerThanIn(srcDir, statSync(GATEWAY_EXE).mtimeMs)) return true;
  const files = [join(GATEWAY_DIR, "package.json"), join(GATEWAY_DIR, "tsconfig.json")];
  return files.some((f) => existsSync(f) && newerThan(f, GATEWAY_EXE));
}

/**
 * Install the gateway's dependencies only when the compiler actually needs
 * them. `bun build --compile` bundles the runtime deps and never touches
 * typescript / bun-types / @types/node, so a devDependency that cannot be
 * downloaded (offline machine, expired TLS cert on a mirror) must not block
 * `bun run dev`. A failed install is a warning as long as the runtime deps
 * are already on disk; only a missing runtime dep is fatal.
 */
function ensureGatewayDeps() {
  const modules = join(GATEWAY_DIR, "node_modules");
  const runtimeDeps = Object.keys(
    JSON.parse(readFileSync(join(GATEWAY_DIR, "package.json"), "utf8")).dependencies ?? {},
  );
  const haveRuntimeDeps = runtimeDeps.every((dep) => existsSync(join(modules, ...dep.split("/"))));
  if (haveRuntimeDeps) {
    console.log("[ensure-engine] gateway dependencies present — skipping bun install");
    return;
  }
  if (runSoft("bun", ["install"], GATEWAY_DIR)) return;
  const stillMissing = runtimeDeps.filter((dep) => !existsSync(join(modules, ...dep.split("/"))));
  if (stillMissing.length) {
    console.error(`[ensure-engine] bun install failed and these gateway deps are missing: ${stillMissing.join(", ")}`);
    process.exit(1);
  }
  console.warn("[ensure-engine] bun install failed, but runtime deps are present — continuing");
}

// --- pi engine ---
if (FORCE || engineStale()) {
  console.log(
    FORCE
      ? "[ensure-engine] FORCE_ENGINE_BUILD set — rebuilding pi engine..."
      : "[ensure-engine] pi engine missing or harness sources changed — rebuilding (can take a while)...",
  );
  if (!existsSync(join(HARNESS, "node_modules"))) {
    console.log("[ensure-engine] installing kalo-harness dependencies...");
    run("npm", ["install", "--no-audit", "--no-fund"], HARNESS, true);
  }
  const bash = findBash();
  run(bash.cmd, ["scripts/build-engine.sh"], ROOT, bash.shell);
  if (!existsSync(PI_EXE)) {
    console.error(`[ensure-engine] build finished but ${PI_EXE} is still missing`);
    process.exit(1);
  }
} else {
  console.log("[ensure-engine] pi engine up to date");
}

// --- kalo-gateway ---
if (FORCE || gatewayStale()) {
  console.log("[ensure-engine] building kalo-gateway...");
  ensureGatewayDeps();
  // Via findBash() rather than `bun run build`: the package script shells out
  // to build-gateway.sh, and on Windows a bare `bash` is often WSL's.
  const gwBash = findBash();
  run(gwBash.cmd, ["scripts/build-gateway.sh", "--skip-typecheck"], ROOT, gwBash.shell);
  if (!existsSync(GATEWAY_EXE)) {
    console.error(`[ensure-engine] gateway build finished but ${GATEWAY_EXE} is still missing`);
    process.exit(1);
  }
} else {
  console.log("[ensure-engine] kalo-gateway up to date");
}
