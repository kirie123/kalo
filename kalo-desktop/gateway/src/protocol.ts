/**
 * NDJSON protocol spoken with the kalo-desktop Rust backend.
 *
 * Rust → gateway (stdin):  {"cmd":"pair_start"| "pair_cancel" | "unbind" |
 *                            "event" | "session_exit", ...}
 * gateway → Rust (stdout): one JSON object per line (see OutMessage).
 */

export type GatewayState = "connecting" | "connected" | "disconnected";

export type InCommand =
  | { cmd: "pair_start" }
  | { cmd: "pair_cancel" }
  | { cmd: "unbind" }
  | { cmd: "event"; sessionId: string; cwd: string; payload: any }
  | { cmd: "session_exit"; sessionId: string; code: number | null };

export type OutMessage =
  | { type: "pair_qr"; qrDataUrl: string; expiresIn: number }
  | { type: "status"; state: GatewayState; user?: string; message?: string }
  | { type: "error"; message: string };

/** Emit one message to Rust (stdout NDJSON). Must stay the ONLY stdout writer. */
export function send(msg: OutMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

export function log(...args: unknown[]): void {
  console.error("[kalo-gateway]", ...args);
}
