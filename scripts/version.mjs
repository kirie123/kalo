#!/usr/bin/env node
/**
 * Single source of truth for the Kalo version number.
 *
 * The version is duplicated across four hand-maintained files (plus the Cargo
 * lockfile), and Tauri reads its own copy — so bumping by hand means the
 * installer, the crate and the package manifests silently drift apart. This
 * script rewrites all of them at once.
 *
 * Usage (repo root):
 *   bun scripts/version.mjs              # print current versions, flag drift
 *   bun scripts/version.mjs patch        # 0.1.0 -> 0.1.1
 *   bun scripts/version.mjs minor        # 0.1.0 -> 0.2.0
 *   bun scripts/version.mjs major        # 0.1.0 -> 1.0.0
 *   bun scripts/version.mjs 1.4.2        # set explicitly
 *   bun scripts/version.mjs patch --dry-run
 *
 * Or via npm scripts: bun run version:show | version:patch | version:minor |
 * version:major | version:set 1.4.2
 *
 * Edits are text-level (regex on the version field) so file formatting,
 * comments and key order stay untouched. No git commit or tag is made.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAURI = join(ROOT, "kalo-desktop", "src-tauri");

/** Every file carrying the app version, with how to read/rewrite it. */
const TARGETS = [
  { path: join(ROOT, "package.json"), ...jsonField() },
  { path: join(ROOT, "kalo-desktop", "package.json"), ...jsonField() },
  { path: join(TAURI, "tauri.conf.json"), ...jsonField() },
  { path: join(TAURI, "Cargo.toml"), ...cargoToml() },
  // The lockfile pins the crate's own version; a stale entry makes the next
  // `cargo build` rewrite it as an unrelated diff.
  { path: join(TAURI, "Cargo.lock"), ...cargoLock("kalo"), optional: true },
];

/** `"version": "x.y.z"` — first occurrence only (deps use their own keys). */
function jsonField() {
  const re = /("version"\s*:\s*")([^"]+)(")/;
  return {
    read: (text) => text.match(re)?.[2],
    write: (text, next) => text.replace(re, (_m, a, _old, c) => `${a}${next}${c}`),
  };
}

/** `version = "x.y.z"` inside the `[package]` table. */
function cargoToml() {
  const re = /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
  return {
    read: (text) => text.match(re)?.[2],
    write: (text, next) => text.replace(re, (_m, a, _old, c) => `${a}${next}${c}`),
  };
}

/** The `[[package]] name = "<crate>"` entry in Cargo.lock. */
function cargoLock(crate) {
  const re = new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")([^"]+)(")`);
  return {
    read: (text) => text.match(re)?.[2],
    write: (text, next) => text.replace(re, (_m, a, _old, c) => `${a}${next}${c}`),
  };
}

function fail(msg) {
  console.error(`版本脚本: ${msg}`);
  process.exit(1);
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function bump(current, kind) {
  const parts = parseSemver(current);
  if (!parts) fail(`当前版本号 "${current}" 不是 x.y.z，无法自动递增；请显式传入目标版本`);
  const [major, minor, patch] = parts;
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const target = args.find((a) => !a.startsWith("-"));

// Read every file up front: nothing is written until all of them parse, so a
// rename or format change can't leave the tree half-bumped.
const files = [];
for (const t of TARGETS) {
  let text;
  try {
    text = readFileSync(t.path, "utf8");
  } catch (err) {
    if (t.optional && err.code === "ENOENT") continue;
    fail(`读不到 ${relative(ROOT, t.path)}: ${err.message}`);
  }
  const version = t.read(text);
  if (!version) fail(`在 ${relative(ROOT, t.path)} 里找不到版本字段（文件格式变了？）`);
  files.push({ ...t, text, version, rel: relative(ROOT, t.path).replaceAll("\\", "/") });
}

const versions = [...new Set(files.map((f) => f.version))];
const current = files[0].version;

if (!target) {
  for (const f of files) console.log(`${f.version.padEnd(12)} ${f.rel}`);
  if (versions.length > 1) {
    console.log(`\n版本号不一致：${versions.join(", ")}`);
    console.log(`用 \`bun scripts/version.mjs ${current}\` 统一，或直接指定目标版本。`);
    process.exit(1);
  }
  console.log(`\n当前版本 ${current}`);
  console.log("递增：bun run version:patch | version:minor | version:major");
  console.log("指定：bun run version:set 1.4.2");
  process.exit(0);
}

const next = ["patch", "minor", "major"].includes(target) ? bump(current, target) : target;
if (!parseSemver(next)) fail(`目标版本 "${next}" 不是 x.y.z 形式`);

if (versions.length > 1) console.log(`注意：改动前版本号并不一致（${versions.join(", ")}），将全部写成 ${next}`);

for (const f of files) {
  const updated = f.write(f.text, next);
  const mark = f.version === next ? "=" : "→";
  console.log(`${mark} ${f.rel}: ${f.version} → ${next}`);
  if (!dryRun && updated !== f.text) writeFileSync(f.path, updated);
}

if (dryRun) {
  console.log("\n--dry-run：未写入任何文件");
} else {
  console.log(`\n版本号已更新为 ${next}。请自行提交，例如：`);
  console.log(`  git commit -am "chore: bump version to ${next}" && git tag v${next}`);
}
