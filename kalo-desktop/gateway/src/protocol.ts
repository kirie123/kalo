/**
 * NDJSON protocol spoken with the kalo-desktop Rust backend.
 *
 * Rust → gateway (stdin):  one JSON object per line (see InCommand).
 * gateway → Rust (stdout): one JSON object per line (see OutMessage).
 */

import type { FeedInfo, FeedSpec } from "./feeds";
import type { JobProbe, JobRule } from "./jobs/store";
import type { JobSnapshot } from "./jobs/types";
import type { ScheduleTask, ScheduleTaskInfo } from "./scheduler";

/** job_start payload: everything the caller may specify for a command job. */
export interface JobStartRequest {
  label: string;
  cwd: string;
  cmd: string;
  env?: Record<string, string>;
  gate?: JobProbe;
  health?: JobProbe;
  rules?: JobRule[];
  /** Owner fence: only this session sees/controls the job (omit = shared). */
  owner?: string;
}

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
  | { cmd: "session_start_failed"; taskId: string; error: string }
  // Job runtime (P0-1). `requestId` correlates the reply; `caller` is the
  // owner fence (session id, or omitted for desktop-wide callers).
  | { cmd: "job_start"; requestId: string; caller?: string; job: JobStartRequest }
  | { cmd: "job_status"; requestId: string; caller?: string; id?: string }
  | { cmd: "job_logs"; requestId: string; caller?: string; id: string }
  | { cmd: "job_stop"; requestId: string; caller?: string; id: string; reason?: string }
  | { cmd: "job_metrics"; requestId: string; caller?: string; id: string; tail?: number }
  // Feeds (declarative periodic pull)
  | { cmd: "feed_upsert"; spec: FeedSpec }
  | { cmd: "feed_remove"; id: string }
  | { cmd: "feed_run"; id: string }
  | { cmd: "feed_list" };

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
    }
  // Job runtime (P0-1). One reply per request, echoing `requestId`.
  | { type: "job_reply"; requestId: string; ok: true; jobs?: JobSnapshot[]; text?: string; metrics?: unknown[]; id?: string; result?: string }
  | { type: "job_reply"; requestId: string; ok: false; error: string }
  /** Unsolicited: a job changed or finished (drives the desktop panel). */
  | { type: "job_event"; event: "changed" | "done"; owner?: string; job?: JobSnapshot }
  // Feeds: one full table snapshot whenever a spec or a value changed.
  | { type: "feed_status"; feeds: FeedInfo[] }
  | { type: "feed_error"; message: string };

/** Emit one message to Rust (stdout NDJSON). Must stay the ONLY stdout writer. */
export function send(msg: OutMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

export function log(...args: unknown[]): void {
  console.error("[kalo-gateway]", ...args);
}
