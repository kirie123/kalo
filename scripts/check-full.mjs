#!/usr/bin/env node
/**
 * check-full.mjs — 全量校验（CI 与发布前使用）
 *
 * 按层依次跑：TS typecheck → vitest → cargo check。任何一步失败即中断。
 * 用 execFileSync 直接调本地二进制，避免 npm/npx 走 registry（防证书/网络问题）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DT = path.join(ROOT, "kalo-desktop");

const steps = [
  ["TypeScript typecheck", path.join(DT, "node_modules/.bin/tsc"), ["--noEmit"], DT],
  ["Vitest 单测", path.join(DT, "node_modules/.bin/vitest"), ["run"], DT],
  ["Rust cargo check", "cargo", ["check"], path.join(DT, "src-tauri")],
];

let ok = true;
for (const [label, cmd, args, cwd] of steps) {
  console.log(`\n── ${label} ──`);
  try {
    execFileSync(cmd, args, { cwd, stdio: "inherit" });
    console.log(`✅ ${label}`);
  } catch {
    console.error(`❌ ${label} 失败`);
    ok = false;
    break;
  }
}

process.exit(ok ? 0 : 1);
