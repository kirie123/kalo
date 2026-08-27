#!/usr/bin/env node
/**
 * check-changed.mjs — changed-aware 单验证策略（对齐根 AGENTS.md「单验证策略」）
 *
 * 原理：根据 git 改动面只跑对应检查，不重复跑全量。
 *   - 改了 kalo-desktop/src/*.ts → 只跑 tsc + vitest
 *   - 改了 src-tauri/*.rs        → 只跑 cargo check（可选 --with-tests 跑 cargo test）
 *   - 改了 scripts/ AGENTS.md    → 跑机器检查（file-length + bridge-contract）
 *   - 改了 kalo-harness/*        → 提示按 kalo-harness/AGENTS.md 走 npm run check（用户决定）
 *   - 只改 doc/ 或其他            → 无需跑检查
 *
 * 用法：
 *   node scripts/check-changed.mjs            # 自动判定改动面并跑对应检查
 *   node scripts/check-changed.mjs --dry-run  # 只打印计划不执行
 *   node scripts/check-changed.mjs --failed-only  # 重跑上次失败项（简化版：直接重跑全部已选）
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

/** 相对 HEAD 的改动文件列表（含未跟踪） */
function changedFiles() {
  const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean);
  return [...tracked, ...untracked];
}

const files = changedFiles();
const plan = new Set();

for (const f of files) {
  if (f.startsWith("kalo-desktop/src/") && (f.endsWith(".ts") || f.endsWith(".tsx"))) {
    plan.add("desktop-ts"); // tsc + vitest
  }
  if (f.startsWith("kalo-desktop/src-tauri/") && f.endsWith(".rs")) {
    plan.add("desktop-rust"); // cargo check
  }
  if (f.startsWith("scripts/") || f.startsWith("AGENTS.md") || f === ".quality-baseline.json") {
    plan.add("machine-checks"); // file-length + bridge-contract
  }
  if (f.startsWith("kalo-harness/")) {
    plan.add("harness-reminder"); // 提示用户走上游 check
  }
}

if (files.length === 0) {
  console.log("[check-changed] 无改动，跳过。");
  process.exit(0);
}

console.log(`[check-changed] 改动文件 ${files.length} 个 → 计划: ${[...plan].join(", ") || "无检查（仅文档/其他）"}`);

if (dryRun) process.exit(0);

const run = (label, cmd, args, cwd) => {
  console.log(`\n── ${label} ──`);
  try {
    execFileSync(cmd, args, { cwd: cwd || ROOT, stdio: "inherit" });
    console.log(`✅ ${label}`);
    return true;
  } catch {
    console.error(`❌ ${label} 失败`);
    return false;
  }
};

let ok = true;
if (plan.has("desktop-ts")) {
  ok = run("TypeScript typecheck", "node_modules/.bin/tsc", ["--noEmit"], path.join(ROOT, "kalo-desktop")) && ok;
  ok = run("Vitest 单测", "node_modules/.bin/vitest", ["run"], path.join(ROOT, "kalo-desktop")) && ok;
}
if (plan.has("desktop-rust")) {
  ok = run("Rust cargo check", "cargo", ["check"], path.join(ROOT, "kalo-desktop/src-tauri")) && ok;
}
if (plan.has("machine-checks")) {
  ok = run("文件行数 ratchet", process.execPath, ["scripts/check-file-length.mjs", "--strict"], ROOT) && ok;
  ok = run("桥接契约漂移", process.execPath, ["scripts/check-bridge-contract.mjs"], ROOT) && ok;
}
if (plan.has("harness-reminder")) {
  console.warn("\n⚠️ 检测到 kalo-harness/ 改动：按 kalo-harness/AGENTS.md 需运行其 `npm run check`（本脚本不代跑，避免误触上游全量检查）。");
}

process.exit(ok ? 0 : 1);
