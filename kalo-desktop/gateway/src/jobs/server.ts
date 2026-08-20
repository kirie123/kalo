/**
 * Jobs control endpoint (P0-1 §1) — how a pi session reaches the job runtime.
 *
 * The gateway owns the jobs; sessions live in other processes (spawned by the
 * desktop, or by hand in a terminal) and its stdio is already taken by the
 * NDJSON protocol with Rust. So the registry is also exposed over a loopback
 * HTTP endpoint: one generic transport, no per-caller plumbing.
 *
 * Discovery + auth: the server writes ~/.kalo/agent/jobs/endpoint.json with
 * {url, token, pid} at startup and removes it at shutdown. A client reads that
 * file (same-user filesystem permission IS the trust boundary) and presents the
 * token as a bearer. The listener binds 127.0.0.1 only.
 *
 * Owner fencing rides on the `x-kalo-session` header and is enforced by the
 * backend, not here — this file is transport, not policy.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "../protocol";
import { jobsDir } from "./store";
import type { GatewayJobBackend } from "./gateway-backend";

/** What a client needs to reach the endpoint. */
export interface JobsEndpoint {
  url: string;
  token: string;
  pid: number;
}

export function endpointFile(dir: string = jobsDir()): string {
  // Sibling of the job records, one level up next to schedules.json.
  return join(dir, "endpoint.json");
}

/** Read the endpoint descriptor, or null when no gateway is publishing one. */
export function readEndpoint(dir?: string): JobsEndpoint | null {
  const file = endpointFile(dir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof raw?.url !== "string" || typeof raw?.token !== "string") return null;
    return { url: raw.url, token: raw.token, pid: Number(raw.pid) || 0 };
  } catch {
    return null;
  }
}

export interface JobsServerDeps {
  /** Directory holding the endpoint descriptor (tests override this). */
  dir?: string;
  /** Fixed port; 0 (default) asks the OS for a free one. */
  port?: number;
}

export class JobsServer {
  private server: { stop(closeActive?: boolean): void; port: number } | null = null;
  private readonly token = randomUUID();
  private readonly dir: string;

  constructor(private jobs: GatewayJobBackend, private deps: JobsServerDeps = {}) {
    this.dir = deps.dir ?? jobsDir();
  }

  start(): JobsEndpoint {
    if (this.server) return this.endpoint();
    // Bun.serve is available in the compiled sidecar (bun-windows-x64 target).
    this.server = (globalThis as any).Bun.serve({
      hostname: "127.0.0.1",
      port: this.deps.port ?? 0,
      fetch: (req: Request) => this.handle(req),
    });
    const ep = this.endpoint();
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(endpointFile(this.dir), JSON.stringify(ep, null, 2) + "\n");
    log(`jobs endpoint listening on ${ep.url}`);
    return ep;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    try {
      rmSync(endpointFile(this.dir), { force: true });
    } catch {
      // Best effort: a stale descriptor is rejected by the token check anyway.
    }
  }

  endpoint(): JobsEndpoint {
    if (!this.server) throw new Error("jobs endpoint is not running");
    return { url: `http://127.0.0.1:${this.server.port}`, token: this.token, pid: process.pid };
  }

  // ------------------------------------------------------------------ routes

  private async handle(req: Request): Promise<Response> {
    if (!this.authorized(req)) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const caller = req.headers.get("x-kalo-session") || undefined;

    try {
      return await this.route(req, url, parts, caller);
    } catch (err) {
      // Backend errors are user-visible messages (unknown job, bad input), so
      // they travel as 400 rather than being swallowed into a 500.
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  private async route(req: Request, url: URL, parts: string[], caller?: string): Promise<Response> {
    const method = req.method.toUpperCase();

    if (parts[0] === "health" && method === "GET") {
      return json({ ok: true, pid: process.pid });
    }

    if (parts[0] === "completions" && parts[1] === "claim" && method === "POST") {
      return json({ jobs: this.jobs.claimCompletions(caller) });
    }

    if (parts[0] !== "jobs") return json({ error: "not found" }, 404);

    // /jobs
    if (parts.length === 1) {
      if (method === "GET") return json({ jobs: this.jobs.list(caller) });
      if (method === "POST") {
        const body = (await req.json()) as any;
        const id = this.jobs.startCommand({ ...body, owner: body?.owner ?? caller });
        return json({ id, job: this.jobs.get(id, caller) });
      }
      return json({ error: "method not allowed" }, 405);
    }

    const id = decodeURIComponent(parts[1]);

    // /jobs/:id
    if (parts.length === 2 && method === "GET") return json({ job: this.jobs.get(id, caller) });

    // /jobs/:id/<action>
    if (parts.length === 3) {
      const action = parts[2];
      if (action === "output" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        if (body?.wait) {
          const timeout = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 30_000;
          await this.jobs.wait(id, timeout, caller);
        }
        const read = this.jobs.read(id, caller);
        return json({ text: read.text, job: read.snapshot });
      }
      if (action === "kill" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const result = this.jobs.kill(id, caller, body?.reason);
        return json({ result, job: this.jobs.get(id, caller) });
      }
      if (action === "metrics" && method === "GET") {
        const tail = Number(url.searchParams.get("tail")) || undefined;
        return json({ metrics: this.jobs.metrics(id, caller, tail) });
      }
    }

    return json({ error: "not found" }, 404);
  }

  private authorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Length-independent compare is overkill on loopback, but the check must
    // not short-circuit on the first differing byte for a same-length token.
    if (presented.length !== this.token.length) return false;
    let diff = 0;
    for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ this.token.charCodeAt(i);
    return diff === 0;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
