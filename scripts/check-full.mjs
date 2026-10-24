#!/usr/bin/env node
/**
 * check-full.mjs — 全量校验（CI 与发布前使用）
 *
 * 按层依次跑：TS typecheck → vitest → cargo check。任何一步失败即中断。
 * 用 execFileSync 直接调本地二进制，避免 npm/npx 走 registry（防证书/网络问题）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { packageStep } from "./check-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DT = path.join(ROOT, "kalo-desktop");

const steps = [
  packageStep("TypeScript typecheck", "typescript", "bin/tsc", ["--noEmit"], DT),
  packageStep("Vitest 单测", "vitest", "vitest.mjs", ["run"], DT),
  packageStep("Gateway typecheck", "typescript", "bin/tsc", ["--noEmit"], path.join(DT, "gateway")),
  ["Gateway 单测", "bun", ["test"], path.join(DT, "gateway")],
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
