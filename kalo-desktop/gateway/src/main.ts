/**
 * kalo-gateway sidecar entry point.
 *
 * Speaks NDJSON over stdin/stdout with the kalo-desktop Rust backend
 * (src-tauri/src/gateway.rs). Responsibilities:
 *   - device-flow QR pairing with Feishu / Lark (scan-to-create-app)
 *   - WebSocket long connection via the official SDK (auto-reconnect)
 *   - read-only progress push: engine events → one live-edited message
 *
 * Lifetime is owned by the Rust side: it spawns, restarts on crash and
 * kills this process on app exit / unbind.
 */

import readline from "node:readline";
import {
  acquireLock,
  deleteCredentials,
  loadCredentials,
  releaseLock,
  saveCredentials,
  type FeishuCredentials,
} from "./credentials";
import { FeishuConnection } from "./feishu";
import { send, log, type InCommand } from "./protocol";
import {
  RegistrationDenied,
  beginRegistration,
  pollRegistration,
  probeBot,
  qrDataUrl,
} from "./registration";
import { ProgressRenderer } from "./renderer";

// ---------------------------------------------------------------------------
// Guard the NDJSON stdout channel: everything libraries print via
// console.log/info/debug must go to stderr instead.
// ---------------------------------------------------------------------------
for (const method of ["log", "info", "debug"] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

let connection: FeishuConnection | null = null;
let renderer: ProgressRenderer | null = null;
let pairing = false;
let cancelPairing: (() => void) | null = null;

function emitStatus(
  state: "connecting" | "connected" | "disconnected",
  extra?: { user?: string; message?: string },
): void {
  send({ type: "status", state, ...extra });
}

function emitError(message: string): void {
  send({ type: "error", message });
}

async function connect(creds: FeishuCredentials): Promise<void> {
  emitStatus("connecting");
  const conn = new FeishuConnection(creds);
  await conn.start();
  connection = conn;
  renderer = new ProgressRenderer(conn);
  emitStatus("connected", { user: creds.botName ? `${creds.botName} · ${creds.boundOpenId}` : creds.boundOpenId });
}

async function runPairing(): Promise<void> {
  pairing = true;
  let cancelled = false;
  cancelPairing = () => {
    cancelled = true;
  };

  try {
    const begin = await beginRegistration();
    if (cancelled) throw new RegistrationDenied("cancelled", "已取消扫码");

    send({
      type: "pair_qr",
      qrDataUrl: await qrDataUrl(begin.qrUrl),
      expiresIn: begin.expireIn,
    });

    const result = await pollRegistration({
      begin,
      isCancelled: () => cancelled,
    });
    if (!result.openId) {
      throw new Error("扫码成功但未返回用户身份（open_id），请重试");
    }

    const botName = await probeBot(result.appId, result.appSecret, result.domain);
    const creds: FeishuCredentials = {
      appId: result.appId,
      appSecret: result.appSecret,
      boundOpenId: result.openId,
      domain: result.domain,
      botName: botName ?? undefined,
      boundAt: new Date().toISOString(),
    };
    saveCredentials(creds);
    log("paired, bot:", botName ?? "unknown");

    await connect(creds);
  } catch (err) {
    if (err instanceof RegistrationDenied) {
      // Expected UX outcomes → back to idle with a hint (not a red error).
      emitStatus("disconnected", { message: err.message });
    } else {
      log("pairing failed:", err instanceof Error ? err.stack ?? err.message : err);
      emitError(`扫码连接失败：${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    pairing = false;
    cancelPairing = null;
  }
}

function handleCommand(cmd: InCommand): void {
  switch (cmd.cmd) {
    case "pair_start": {
      if (connection) {
        emitStatus("connected", { user: loadCredentials()?.boundOpenId });
        return;
      }
      if (pairing) return; // already in flight
      void runPairing();
      return;
    }
    case "pair_cancel": {
      cancelPairing?.();
      if (!pairing) emitStatus("disconnected");
      return;
    }
    case "unbind": {
      renderer?.dispose();
      renderer = null;
      connection = null;
      deleteCredentials();
      emitStatus("disconnected");
      releaseLock();
      // Rust marked this exit deliberate (stopping=true) — no restart.
      process.exit(0);
    }
    case "event": {
      renderer?.handleEvent(cmd.sessionId, cmd.cwd, cmd.payload);
      return;
    }
    case "session_exit": {
      renderer?.handleExit(cmd.sessionId, cmd.code);
      return;
    }
  }
}

function main(): void {
  if (!acquireLock()) {
    // Another gateway instance owns the lock. Stay alive (no exit loop) but
    // refuse to work; the Rust side surfaces this as an error state.
    emitError("另一个 Kalo 网关实例正在运行（feishu.lock 被占用）");
    return;
  }

  process.on("exit", releaseLock);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("uncaughtException", (err) => {
    log("uncaught:", err instanceof Error ? err.stack ?? err.message : err);
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandled rejection:", reason);
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handleCommand(JSON.parse(trimmed) as InCommand);
    } catch (err) {
      log("bad command:", trimmed, err instanceof Error ? err.message : err);
    }
  });
  // Rust kills us on shutdown; stdin EOF only happens if the parent died.
  rl.on("close", () => process.exit(0));

  // Startup: resume from persisted credentials or wait for pairing.
  const creds = loadCredentials();
  if (creds) {
    connect(creds).catch((err) => {
      log("connect failed:", err instanceof Error ? err.stack ?? err.message : err);
      emitError(`飞书连接失败：${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    emitStatus("disconnected");
  }
}

main();
