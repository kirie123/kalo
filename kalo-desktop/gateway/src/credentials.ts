/**
 * Feishu credentials persistence and single-instance lock.
 *
 * Credentials live in ~/.kalo/agent/feishu.json (same directory policy as
 * models.json / auth.json, 0600). A PID lock file prevents two gateway
 * instances from driving the same app concurrently.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  /** open_id of the user who scanned the QR code — the only authorized user. */
  boundOpenId: string;
  domain: "feishu" | "lark";
  botName?: string;
  boundAt: string;
}

const agentDir = join(homedir(), ".kalo", "agent");
const credFile = join(agentDir, "feishu.json");
const lockFile = join(agentDir, "feishu.lock");

export function loadCredentials(): FeishuCredentials | null {
  try {
    const data = JSON.parse(readFileSync(credFile, "utf-8"));
    if (
      typeof data?.appId === "string" &&
      typeof data?.appSecret === "string" &&
      typeof data?.boundOpenId === "string"
    ) {
      return {
        appId: data.appId,
        appSecret: data.appSecret,
        boundOpenId: data.boundOpenId,
        domain: data.domain === "lark" ? "lark" : "feishu",
        botName: typeof data.botName === "string" ? data.botName : undefined,
        boundAt: typeof data.boundAt === "string" ? data.boundAt : new Date().toISOString(),
      };
    }
  } catch {
    // missing or invalid — treat as unbound
  }
  return null;
}

export function saveCredentials(creds: FeishuCredentials): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(credFile, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export function deleteCredentials(): void {
  rmSync(credFile, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Acquire the gateway singleton lock. Stale locks (dead PID) are reclaimed.
 */
export function acquireLock(): boolean {
  mkdirSync(agentDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx": fail if the file already exists.
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") return false;
      // Existing lock: reclaim it when the owner is gone.
      try {
        const pid = Number.parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
        if (Number.isFinite(pid) && !isProcessAlive(pid)) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {
        unlinkSync(lockFile);
        continue;
      }
      return false;
    }
  }
  return false;
}

export function releaseLock(): void {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
    if (pid === process.pid) unlinkSync(lockFile);
  } catch {
    // lock already gone
  }
}

export function credentialsFileExists(): boolean {
  return existsSync(credFile);
}
