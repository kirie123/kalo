#!/usr/bin/env node
/**
 * Pre-dev/build guard: make sure the pi engine and kalo-gateway sidecars are
 * staged into kalo-desktop/src-tauri/binaries/ before `tauri dev|build`.
 * (The Tauri build script hard-fails when bundle resources are missing.)
 *
 * Fast path: binaries present → exits immediately.
 * Slow path (first run, or FORCE_ENGINE_BUILD=1):
 *   1. install kalo-harness dependencies if node_modules is missing
 *   2. scripts/build-engine.sh  → pi.exe + runtime resources
 *   3. compile the gateway sidecar with bun
 *
 * Run via bun at the repo root: `bun scripts/ensure-engine.mjs`
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BINARIES = join(ROOT, "kalo-desktop", "src-tauri", "binaries");
const PI_EXE = join(BINARIES, "pi-x86_64-pc-windows-msvc.exe");
const GATEWAY_EXE = join(BINARIES, "kalo-gateway-x86_64-pc-windows-msvc.exe");
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

const newerThan = (file, reference) => statSync(file).mtimeMs > statSync(reference).mtimeMs;

/** Gateway rebuild is cheap: trigger on missing exe or changed sources. */
function gatewayStale() {
  if (!existsSync(GATEWAY_EXE)) return true;
  const srcDir = join(GATEWAY_DIR, "src");
  const files = [
    join(GATEWAY_DIR, "package.json"),
    join(GATEWAY_DIR, "tsconfig.json"),
    ...readdirSync(srcDir).map((f) => join(srcDir, f)),
  ];
  return files.some((f) => existsSync(f) && newerThan(f, GATEWAY_EXE));
}

// --- pi engine ---
if (FORCE || !existsSync(PI_EXE)) {
  console.log("[ensure-engine] pi engine missing (or forced) — building, first run can take a while...");
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
  run("bun", ["install"], GATEWAY_DIR);
  run("bun", ["run", "build"], GATEWAY_DIR);
  if (!existsSync(GATEWAY_EXE)) {
    console.error(`[ensure-engine] gateway build finished but ${GATEWAY_EXE} is still missing`);
    process.exit(1);
  }
} else {
  console.log("[ensure-engine] kalo-gateway up to date");
}
