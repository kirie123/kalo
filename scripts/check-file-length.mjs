#!/usr/bin/env node
/**
 * check-file-length.mjs — 业务代码 ≤800 行（排除空行/纯注释行）ratchet 检查
 *
 * 规则（对齐根 AGENTS.md）：
 *  - 业务文件（.ts/.tsx/.rs）超过 800 行（排除空行与注释行）即报错
 *  - 基线文件 .quality-baseline.json 记录当前超限文件；新增超限文件 = 失败（只许缩）
 *  - 超限文件若已被修短到 800 内，会自动从基线移除（缩是允许的）
 *
 * 用法：
 *  node scripts/check-file-length.mjs            # 检查 + 自动更新基线（本地用）
 *  node scripts/check-file-length.mjs --strict   # 检查但不更新基线（CI 用，漂移即失败）
 *  node scripts/check-file-length.mjs --init     # 生成初始基线
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIMIT = 800;
const BASELINE = path.join(ROOT, ".quality-baseline.json");

/** 扫描 .ts/.tsx/.rs，排除测试/生成文件，返回 { relPath: nonBlankLines } */
function scan() {
  const out = {};
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "kalo-desktop/src/lib", "kalo-desktop/src/features", "kalo-desktop/src-tauri/src"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n");
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "kalo-desktop/src/lib", "kalo-desktop/src/features", "kalo-desktop/src-tauri/src"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n");
  const files = [...tracked, ...untracked]
    .filter(Boolean)
    .filter(
      (f) =>
        (f.endsWith(".ts") || f.endsWith(".rs")) &&
        !f.includes(".test.") &&
        !f.includes(".spec.")
    );

  for (const f of files) {
    if (f.includes(".test.") || f.includes(".spec.") || f.endsWith(".gen.")) continue;
    const abs = path.join(ROOT, f);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    let count = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue; // 空行
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue; // 注释行
      if (t.startsWith("#[") && t.endsWith("]")) continue; // Rust attribute
      count++;
    }
    if (count > LIMIT) out[f] = count;
  }
  return out;
}

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const init = argv.includes("--init");

const over = scan();
const overPaths = Object.keys(over).sort();

if (init) {
  writeFileSync(BASELINE, JSON.stringify(over, null, 2) + "\n", "utf8");
  console.log(`[check-file-length] 基线已生成：${overPaths.length} 个超限文件`);
  process.exit(0);
}

let baseline = {};
if (existsSync(BASELINE)) {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
}

// 已修复（从超限变不超限）→ 自动从基线移除（缩 OK）
const fixed = Object.keys(baseline).filter((p) => !over[p]);
for (const p of fixed) delete baseline[p];

// 新增超限（基线里没有，或比基线更长）→ 失败
const newlyOver = overPaths.filter((p) => !(p in baseline) || over[p] > baseline[p]);
// 变短但仍在基线 → 更新基线（缩 OK）
for (const p of overPaths) {
  if (p in baseline && over[p] < baseline[p]) baseline[p] = over[p];
}

let failed = false;
if (newlyOver.length > 0) {
  failed = true;
  console.error("[check-file-length] ✗ 新增超限文件（只许缩不许增，需拆分重构）：");
  for (const p of newlyOver) {
    console.error(`  ${over[p]} 行  ${p}`);
  }
}

if (!strict) {
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

const remaining = Object.keys(over).length;
console.log(
  `[check-file-length] 超限文件 ${remaining} 个` +
    (strict ? "" : "（基线已更新）") +
    (failed ? "" : " ✅")
);
process.exit(failed ? 1 : 0);
