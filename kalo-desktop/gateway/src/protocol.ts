/**
 * NDJSON protocol spoken with the kalo-desktop Rust backend.
 *
 * Rust → gateway (stdin):  one JSON object per line (see InCommand).
 * gateway → Rust (stdout): one JSON object per line (see OutMessage).
 */

import type { ScheduleTask, ScheduleTaskInfo } from "./scheduler";

export type GatewayState = "connecting" | "connected" | "disconnected";

export type InCommand =
  | { cmd: "pair_start" }
  | { cmd: "pair_cancel" }
  | { cmd: "unbind" }
  | { cmd: "event"; sessionId: string; cwd: string; payload: any }
  | { cmd: "session_exit"; sessionId: string; code: number | null }
  // Scheduler (P0-A)
  | { cmd: "schedule_upsert"; task: ScheduleTask }
  | { cmd: "schedule_remove"; id: string }
  | { cmd: "schedule_run"; id: string }
  | { cmd: "schedule_list" }
  // Rust bookkeeping replies for scheduler-requested headless sessions
  | { cmd: "session_started"; taskId: string; sessionId: string }
  | { cmd: "session_start_failed"; taskId: string; error: string };

export type OutMessage =
  | { type: "pair_qr"; qrDataUrl: string; expiresIn: number }
  | { type: "status"; state: GatewayState; user?: string; message?: string }
  | { type: "error"; message: string }
  // Scheduler (P0-A)
  | { type: "schedule_status"; tasks: ScheduleTaskInfo[] }
  | { type: "schedule_error"; message: string }
  | {
      type: "session_request";
      taskId: string;
      cwd: string;
      prompt: string;
      model: string | null;
    };

/** Emit one message to Rust (stdout NDJSON). Must stay the ONLY stdout writer. */
export function send(msg: OutMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

export function log(...args: unknown[]): void {
  console.error("[kalo-gateway]", ...args);
}
