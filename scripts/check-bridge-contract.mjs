#!/usr/bin/env node
/**
 * check-bridge-contract.mjs — 引擎通信契约漂移检查
 *
 * 原理（对齐根 AGENTS.md「契约先行」）：
 *  - TS 侧：src/lib/pi-bridge.ts 的 invoke("xxx", ...) 命令名
 *  - Rust 侧：src-tauri/src/main.rs 的 tauri::generate_handler![...] 命令名
 *  - 双向核对：TS 调用了但 Rust 没注册 → 漂移；Rust 注册了但 TS 没用 → 死代码提示
 *
 * 用法：
 *  node scripts/check-bridge-contract.mjs   # exit 0/1
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TS_BRIDGE = path.join(ROOT, "kalo-desktop/src/lib/pi-bridge.ts");
const RS_MAIN = path.join(ROOT, "kalo-desktop/src-tauri/src/main.rs");

/** 从 TS 提取 invoke("cmd", ...) 命令名（字符串字面量） */
function tsCommands() {
  const src = readFileSync(TS_BRIDGE, "utf8");
  const cmds = new Set();
  for (const m of src.matchAll(/invoke(?:<[^>]+>)?\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
    cmds.add(m[1]);
  }
  return cmds;
}

/** 从 Rust 提取 generate_handler 块里的命令名 */
function rsCommands() {
  const src = readFileSync(RS_MAIN, "utf8");
  const start = src.indexOf("generate_handler!");
  if (start < 0) return new Set();
  // 从 generate_handler! 后找配对的 [ ]
  const bracketStart = src.indexOf("[", start);
  if (bracketStart < 0) return new Set();
  let depth = 0;
  let end = bracketStart;
  for (let i = bracketStart; i < src.length; i++) {
    if (src[i] === "[") depth++;
    if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = src.slice(bracketStart + 1, end);
  const cmds = new Set();
  for (const m of block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)/g)) {
    cmds.add(m[1]);
  }
  return cmds;
}

const ts = tsCommands();
const rs = rsCommands();

// 归一化：invoke 用 snake_case 命令，Rust 函数通常是 snake_case；双方都小写比较
const norm = (s) => s.toLowerCase();

const tsNorm = new Set([...ts].map(norm));
const rsNorm = new Set([...rs].map(norm));

// TS 调用但 Rust 未注册 → 运行时会报 "command not found"（致命）
const missing = [...tsNorm].filter((c) => !rsNorm.has(c));
// Rust 注册但 TS 未调用 → 可能是死代码或即将启用（警告）
const unused = [...rsNorm].filter((c) => !tsNorm.has(c));

let failed = false;
if (missing.length > 0) {
  failed = true;
  console.error("[check-bridge-contract] ✗ TS 调用了但 Rust 未注册（运行时会失败）：");
  for (const c of missing.sort()) console.error(`  ${c}`);
} else {
  console.log(`[check-bridge-contract] TS invoke ${ts.size} 个命令全部在 Rust 注册 ✅`);
}

const knownUnused = new Set([
  // 已知仅 Rust 侧或仅供其他调用方使用的命令（白名单，只许缩）
]);
const realUnused = unused.filter((c) => !knownUnused.has(c));
if (realUnused.length > 0) {
  console.warn(`[check-bridge-contract] ⚠️ Rust 注册但 TS 未直接调用 ${realUnused.length} 个（可能是间接调用/死代码，确认后可加白名单）：`);
  for (const c of realUnused.sort().slice(0, 15)) console.warn(`  ${c}`);
}

process.exit(failed ? 1 : 0);
