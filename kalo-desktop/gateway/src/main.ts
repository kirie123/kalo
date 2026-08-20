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
import { homedir } from "node:os";
import {
  acquireLock,
  deleteCredentials,
  loadCredentials,
  releaseLock,
  saveCredentials,
  type FeishuCredentials,
} from "./credentials";
import { FeishuConnection } from "./feishu";
import { Channel } from "./channel";
import { send, log, type InCommand } from "./protocol";
import {
  RegistrationDenied,
  beginRegistration,
  pollRegistration,
  probeBot,
  qrDataUrl,
} from "./registration";
import { GatewayJobBackend } from "./jobs/gateway-backend";
import { JobsServer } from "./jobs/server";
import { OPERATOR } from "./jobs/types";
import { ProgressRenderer } from "./renderer";
import { Scheduler, type ScheduleTask } from "./scheduler";
import { FeedEngine } from "./feeds";

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

// ---------------------------------------------------------------------------
// Scheduler (P0-A): cron/watch/agent tasks living in this sidecar.
// ---------------------------------------------------------------------------

function broadcastSchedules(): void {
  send({ type: "schedule_status", tasks: scheduler.list() });
}

const scheduler = new Scheduler({
  sendAlert: (task, output) => {
    if (!connection) {
      log(`alert for task ${task.id} dropped: feishu not connected`);
      return;
    }
    connection
      .sendText(`[${task.id}] ${task.name}\n${output}`)
      .catch((err) => log(`alert push failed (${task.id}):`, err instanceof Error ? err.message : err));
  },
  requestAgentSession: (task: ScheduleTask) => {
    send({
      type: "session_request",
      taskId: task.id,
      cwd: task.cwd,
      prompt: task.prompt ?? "",
      model: task.model ?? null,
    });
  },
  onChange: broadcastSchedules,
});

// ---------------------------------------------------------------------------
// Feeds: declarative periodic pulls (doc/2026-08-20-feeds-declarative-data-pull.md).
// Values change several times a minute, so the broadcast is coalesced — the
// desktop only ever needs the latest table, never every intermediate state.
// ---------------------------------------------------------------------------

let feedBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastFeeds(): void {
  if (feedBroadcastTimer) return;
  feedBroadcastTimer = setTimeout(() => {
    feedBroadcastTimer = null;
    send({ type: "feed_status", feeds: feeds.list() });
  }, 200);
}

const feeds = new FeedEngine({ onChange: broadcastFeeds });

// ---------------------------------------------------------------------------
// Job runtime (P0-1): detached long-running commands living in this sidecar.
// Jobs outlive this process — a gateway crash/restart re-verifies PIDs rather
// than killing anything (see jobs/gateway-backend.ts).
// ---------------------------------------------------------------------------

const jobs = new GatewayJobBackend({
  onChange: (owner) => send({ type: "job_event", event: "changed", owner }),
});

jobs.onJobDone((job, owner) => {
  send({ type: "job_event", event: "done", owner, job });
  // A finished job is worth a push even when nobody is watching the desktop.
  const verdict = job.status === "completed" ? "✅ 完成" : job.status === "killed" ? "⏹ 已停止" : "❌ 失败";
  connection
    ?.sendText(`[${job.id}] ${job.label}\n${verdict}${job.detail ? `\n${job.detail}` : ""}`)
    .catch((err) => log(`job push failed (${job.id}):`, err instanceof Error ? err.message : err));
});

/**
 * Loopback control endpoint: how a pi session (in another process) reaches the
 * same registry. Our stdio is already the Rust protocol, so the tool layer
 * talks HTTP over 127.0.0.1 with a token from ~/.kalo/agent/jobs/endpoint.json.
 */
const jobsServer = new JobsServer(jobs);

// ---------------------------------------------------------------------------
// Channel (P0-2): one way in and out. Feishu is only the carrier — parsing,
// double-confirm and routing all live in channel.ts.
// ---------------------------------------------------------------------------
const channel = new Channel({
  transport: () => connection,
  listJobs: () => jobs.list(OPERATOR),
  killJob: (id, reason) => jobs.kill(id, OPERATOR, reason),
  listSchedules: () => scheduler.list(),
  requestSession: (taskId, prompt) => {
    send({ type: "session_request", taskId, cwd: channelCwd(), prompt, model: null });
  },
  cwd: channelCwd,
});

/** Neutral cwd for channel-opened sessions: the home that owns ~/.kalo. */
function channelCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

/** Run one job command, replying exactly once with ok/error. */
function handleJobCommand(cmd: Extract<InCommand, { requestId: string }>): void {
  // No caller = the desktop UI asking on the user's behalf, not an anonymous
  // session, so it gets the operator view rather than the unowned-only slice.
  const caller = cmd.caller ?? OPERATOR;
  try {
    switch (cmd.cmd) {
      case "job_start": {
        const id = jobs.startCommand({ ...cmd.job, owner: cmd.job.owner });
        send({ type: "job_reply", requestId: cmd.requestId, ok: true, id, jobs: [jobs.get(id, caller)] });
        return;
      }
      case "job_status": {
        const list = cmd.id ? [jobs.get(cmd.id, caller)] : jobs.list(caller);
        send({ type: "job_reply", requestId: cmd.requestId, ok: true, jobs: list });
        return;
      }
      case "job_logs": {
        const read = jobs.read(cmd.id, caller);
        send({ type: "job_reply", requestId: cmd.requestId, ok: true, text: read.text, jobs: [read.snapshot] });
        return;
      }
      case "job_stop": {
        const result = jobs.kill(cmd.id, caller, cmd.reason);
        send({ type: "job_reply", requestId: cmd.requestId, ok: true, result, jobs: [jobs.get(cmd.id, caller)] });
        return;
      }
      case "job_metrics": {
        const metrics = jobs.metrics(cmd.id, caller, cmd.tail);
        send({ type: "job_reply", requestId: cmd.requestId, ok: true, metrics });
        return;
      }
    }
  } catch (err) {
    send({
      type: "job_reply",
      requestId: cmd.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
  const conn = new FeishuConnection(creds, {
    onText: (text) => {
      void channel.handleText(text);
    },
  });
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
      // Unbind drops the Feishu binding only. The process stays up: it also
      // owns the job runtime, and killing it would take every running job
      // and the model's job tools with it.
      renderer?.dispose();
      renderer = null;
      connection = null;
      deleteCredentials();
      emitStatus("disconnected");
      return;
    }
    case "event": {
      renderer?.handleEvent(cmd.sessionId, cmd.cwd, cmd.payload);
      return;
    }
    case "session_exit": {
      renderer?.handleExit(cmd.sessionId, cmd.code);
      scheduler.handleSessionExit(cmd.sessionId, cmd.code);
      return;
    }
    case "schedule_upsert": {
      const err = scheduler.upsert(cmd.task);
      if (err) send({ type: "schedule_error", message: err });
      return;
    }
    case "schedule_remove": {
      scheduler.remove(cmd.id);
      return;
    }
    case "schedule_run": {
      const err = scheduler.runNow(cmd.id);
      if (err) send({ type: "schedule_error", message: err });
      return;
    }
    case "schedule_list": {
      broadcastSchedules();
      return;
    }
    case "session_started": {
      if (channel.owns(cmd.taskId)) channel.handleSessionStarted(cmd.taskId);
      else scheduler.handleSessionStarted(cmd.taskId, cmd.sessionId);
      return;
    }
    case "session_start_failed": {
      if (channel.owns(cmd.taskId)) channel.handleSessionStartFailed(cmd.taskId, cmd.error);
      else scheduler.handleSessionStartFailed(cmd.taskId, cmd.error);
      return;
    }
    case "job_start":
    case "job_status":
    case "job_logs":
    case "job_stop":
    case "job_metrics": {
      handleJobCommand(cmd);
      return;
    }
    case "feed_upsert": {
      const err = feeds.upsert(cmd.spec);
      if (err) send({ type: "feed_error", message: err });
      return;
    }
    case "feed_remove": {
      feeds.remove(cmd.id);
      return;
    }
    case "feed_run": {
      void feeds.runNow(cmd.id).then((err) => {
        if (err) send({ type: "feed_error", message: err });
      });
      return;
    }
    case "feed_list": {
      send({ type: "feed_status", feeds: feeds.list() });
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

  process.on("exit", () => {
    jobsServer.stop();
    releaseLock();
  });
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

  // Scheduler runs independently of the Feishu connection (alerts are
  // dropped while unpaired, but task bookkeeping still advances).
  scheduler.load();
  scheduler.start();
  broadcastSchedules();

  // Jobs were launched detached: load() re-verifies each recorded PID instead
  // of assuming anything died with the previous gateway process.
  jobs.load();
  jobs.startTicking();
  send({ type: "job_event", event: "changed" });

  // Feeds: load the specs (each with its last snapshot, so the title bar has
  // values before the first pull lands), seed the examples on a fresh install.
  feeds.load();
  feeds.seedExamples();
  feeds.start();
  send({ type: "feed_status", feeds: feeds.list() });

  try {
    jobsServer.start();
  } catch (err) {
    // A dead endpoint costs the model its job tools, not the gateway: the
    // desktop path (NDJSON) and the channel keep working.
    log("jobs endpoint failed to start:", err instanceof Error ? err.message : err);
  }

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
