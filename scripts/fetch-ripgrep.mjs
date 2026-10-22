#!/usr/bin/env node
/**
 * Stage a pinned ripgrep binary into the desktop's bundled binaries dir.
 *
 * The engine's system prompt tells the model to search with `rg`, so a
 * release that ships without it silently falls back to `grep -r` over the
 * whole workspace (node_modules / .next / .git included) — 20s+ on a large
 * repo where ripgrep is sub-second. The harness *can* download rg at runtime
 * (`ensureTool("rg")`), but the installer must not depend on GitHub being
 * reachable, so the binary is staged at build time and shipped inside the
 * package.
 *
 * Output:
 *   kalo-desktop/src-tauri/binaries/rg-<target-triple>[.exe]
 *   kalo-desktop/src-tauri/binaries/.rg-<target-triple>.stamp   (pinned version)
 *
 * The stamp makes repeated dev/build runs offline no-ops. Both files live in
 * the gitignored staging dir; the tauri platform configs pick up the binary
 * from there (see tauri.windows.conf.json / tauri.macos.conf.json).
 *
 * Usage:
 *   node scripts/fetch-ripgrep.mjs [--platform <name>] [--force] [--check]
 *
 *   --platform  one of platform.sh's names (default: this host)
 *   --force     re-stage even when the stamp matches
 *   --check     report whether the staged binary exists; no network
 *
 * Offline / mirrors:
 *   KALO_RG_FROM=<archive path>  stage from a local archive (still checksummed)
 *   KALO_SKIP_RG=1               skip staging; the build proceeds without rg
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BINARIES = join(ROOT, "kalo-desktop", "src-tauri", "binaries");

/**
 * One pin for the whole repo: when bumping VERSION, update every asset name
 * and SHA256 together. Checksums are the values published next to the release
 * assets on GitHub and were verified again by downloading and hashing.
 */
const VERSION = "15.2.0";
const RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}`;

/** Platform names match scripts/platform.sh; triples match Rust/Tauri. */
const PLATFORMS = {
  "windows-x64": {
    triple: "x86_64-pc-windows-msvc",
    suffix: ".exe",
    asset: `ripgrep-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
    archive: "zip",
  },
  "windows-arm64": {
    triple: "aarch64-pc-windows-msvc",
    suffix: ".exe",
    asset: `ripgrep-${VERSION}-aarch64-pc-windows-msvc.zip`,
    sha256: "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
    archive: "zip",
  },
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    suffix: "",
    asset: `ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
    archive: "tar.gz",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    suffix: "",
    asset: `ripgrep-${VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
    archive: "tar.gz",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    suffix: "",
    asset: `ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
    archive: "tar.gz",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    suffix: "",
    asset: `ripgrep-${VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
    archive: "tar.gz",
  },
};

function hostPlatform() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!arch) return null;
  const name = `${os}-${arch}`;
  return PLATFORMS[name] ? name : null;
}

function parseArgs(argv) {
  const opts = { platform: null, force: false, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") opts.platform = argv[++i] ?? "";
    else if (arg === "--force") opts.force = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`[fetch-ripgrep] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      "Stage a pinned ripgrep binary into kalo-desktop/src-tauri/binaries/.",
      "",
      "  node scripts/fetch-ripgrep.mjs [--platform <name>] [--force] [--check]",
      "",
      `  --platform  one of: ${Object.keys(PLATFORMS).join(", ")} (default: host)`,
      "  --force     re-stage even when the stamp matches",
      "  --check     only report whether the staged binary exists (no network)",
      "",
      "  KALO_RG_FROM=<archive path>  stage from a local archive",
      "  KALO_SKIP_RG=1               skip staging (build proceeds without rg)",
    ].join("\n"),
  );
}

/** Run one extraction command; null on success, a description on failure. */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (result.error) return `${cmd}: ${result.error.message}`;
  if (result.status !== 0) return `${cmd}: exit ${result.status} ${(result.stderr ?? "").trim()}`;
  return null;
}

/** tar candidates: prefer Windows' bsdtar when present, else whatever PATH has. */
function tarCandidates() {
  if (process.platform !== "win32") return ["tar"];
  const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(systemTar) ? [systemTar, "tar"] : ["tar"];
}

/**
 * Extract `archiveName` (living in `workDir`) into `extractDir`.
 *
 * The commands run with `cwd: workDir` and see relative paths on purpose:
 * Git-for-Windows' GNU tar parses a `C:/...` archive argument as an rsh
 * `host:path` spec ("Cannot connect to C: resolve failed"), and a relative
 * name sidesteps that entirely. Candidates are tried in order because none
 * is universally present: tar handles .tar.gz everywhere, Windows' System32
 * bsdtar also reads zip, unzip is the unix zip tool, and PowerShell
 * Expand-Archive is the last resort.
 */
function extract(workDir, archiveName, extractDir, kind) {
  const relDest = relative(workDir, extractDir) || ".";
  const failures = [];
  if (kind === "tar.gz") {
    for (const cmd of tarCandidates()) {
      const failure = run(cmd, ["xzf", archiveName, "-C", relDest], workDir);
      if (!failure) return;
      failures.push(failure);
    }
  } else if (process.platform === "win32") {
    for (const cmd of tarCandidates()) {
      const failure = run(cmd, ["xf", archiveName, "-C", relDest], workDir);
      if (!failure) return;
      failures.push(failure);
    }
    const script =
      "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const failure = run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
        extractDir,
      ],
      workDir,
    );
    if (!failure) return;
    failures.push(failure);
  } else {
    const unzipFailure = run("unzip", ["-q", archiveName, "-d", relDest], workDir);
    if (!unzipFailure) return;
    failures.push(unzipFailure);
    const tarFailure = run("tar", ["xf", archiveName, "-C", relDest], workDir);
    if (!tarFailure) return;
    failures.push(tarFailure);
  }
  throw new Error(`cannot extract ${archiveName}: ${failures.join("; ")}`);
}

/** Depth-first search for a file by name; the archives nest it differently. */
function findBinary(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === name) return path;
    }
  }
  return null;
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  const platform = opts.platform || hostPlatform();
  const config = platform ? PLATFORMS[platform] : undefined;
  if (!platform || !config) {
    console.error(
      `[fetch-ripgrep] unsupported platform "${platform ?? `${process.platform}-${process.arch}`}"; ` +
        `valid: ${Object.keys(PLATFORMS).join(", ")}`,
    );
    return 1;
  }

  const staged = join(BINARIES, `rg-${config.triple}${config.suffix}`);
  const stamp = join(BINARIES, `.rg-${config.triple}.stamp`);

  if (opts.check) {
    if (existsSync(staged)) {
      console.log(`[fetch-ripgrep] staged: ${staged}`);
      return 0;
    }
    console.error(`[fetch-ripgrep] missing: ${staged}`);
    return 1;
  }

  const stamped = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
  if (!opts.force && existsSync(staged) && stamped === VERSION) {
    console.log(`[fetch-ripgrep] rg ${VERSION} already staged for ${platform}`);
    return 0;
  }

  if (process.env.KALO_SKIP_RG === "1" || process.env.KALO_SKIP_RG === "true") {
    console.warn(`[fetch-ripgrep] KALO_SKIP_RG set; not staging rg for ${platform}`);
    return 0;
  }

  const work = mkdtempSync(join(tmpdir(), "kalo-rg-"));
  try {
    const archive = join(work, config.asset);
    const local = process.env.KALO_RG_FROM;
    if (local && existsSync(local)) {
      console.log(`[fetch-ripgrep] using KALO_RG_FROM: ${local}`);
      copyFileSync(local, archive);
    } else {
      if (local) console.warn(`[fetch-ripgrep] KALO_RG_FROM is set but missing (${local}); downloading`);
      console.log(`[fetch-ripgrep] downloading rg ${VERSION} for ${platform}...`);
      await download(`${RELEASE_BASE}/${config.asset}`, archive);
    }

    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (actual !== config.sha256) {
      throw new Error(
        `sha256 mismatch for ${config.asset}\n  expected ${config.sha256}\n  actual   ${actual}`,
      );
    }

    const extractDir = join(work, "extract");
    mkdirSync(extractDir, { recursive: true });
    extract(work, config.asset, extractDir, config.archive);

    const found = findBinary(extractDir, `rg${config.suffix}`);
    if (!found) throw new Error(`rg${config.suffix} not found inside ${config.asset}`);

    mkdirSync(BINARIES, { recursive: true });
    const tmpTarget = `${staged}.tmp-${process.pid}`;
    copyFileSync(found, tmpTarget);
    if (!config.suffix) {
      // A cross-staging run on Windows cannot record a unix exec bit, and a
      // native mac/linux run can; failure here must not fail the staging.
      try {
        chmodSync(tmpTarget, 0o755);
      } catch {
        /* Windows or a filesystem without exec bits */
      }
    }
    if (existsSync(staged)) unlinkSync(staged);
    renameSync(tmpTarget, staged);
    writeFileSync(stamp, `${VERSION}\n`);
    console.log(`[fetch-ripgrep] staged ${staged}`);
    return 0;
  } catch (err) {
    console.error(`[fetch-ripgrep] failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "[fetch-ripgrep] hints: KALO_RG_FROM=<archive path> for offline builds, " +
        "or KALO_SKIP_RG=1 to build without rg",
    );
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exit(await main());