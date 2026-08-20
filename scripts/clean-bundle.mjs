#!/usr/bin/env node
/**
 * Pre-build cleanup: delete the previous installer bundle.
 *
 * A `tauri build` that dies before the bundle step (a tsc error, a failed
 * cargo compile) leaves the *last successful* installer sitting at
 * target/release/bundle/, under the exact same filename — the version is
 * pinned in tauri.conf.json, so Kalo_0.1.0_x64-setup.exe from three days ago
 * is indistinguishable from a fresh one. Installing that silently downgrades
 * the app while `tauri dev` keeps showing current code.
 *
 * Removing the directory up front means a failed build leaves no installer at
 * all, which is the honest outcome.
 *
 * Run via bun at the repo root: `bun scripts/clean-bundle.mjs`
 */

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(ROOT, "kalo-desktop", "src-tauri", "target", "release", "bundle");

if (!existsSync(BUNDLE)) {
  console.log("[clean-bundle] no previous bundle — nothing to remove");
} else {
  try {
    rmSync(BUNDLE, { recursive: true, force: true });
    console.log(`[clean-bundle] removed ${BUNDLE}`);
  } catch (err) {
    // A locked file (installer still open, antivirus scanning) must not block
    // the build — but the stale installer is exactly what we came to remove,
    // so say so loudly rather than failing quietly.
    console.warn(`[clean-bundle] could not remove ${BUNDLE}: ${err.message}`);
    console.warn("[clean-bundle] a stale installer may survive a failed build — check its timestamp before installing");
  }
}
