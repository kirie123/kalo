import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./store";
import { GatewayJobBackend } from "./gateway-backend";
import { JobsServer, endpointFile, readEndpoint } from "./server";
import { OPERATOR } from "./types";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface Harness {
  dir: string;
  backend: GatewayJobBackend;
  server: JobsServer;
  url: string;
  token: string;
}

function makeServer(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kalo-jobs-server-test-"));
  const backend = new GatewayJobBackend({ store: new JobStore(dir) });
  const server = new JobsServer(backend, { dir });
  const ep = server.start();
  cleanups.push(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, backend, server, url: ep.url, token: ep.token };
}

/** Authenticated request as `session` (undefined = anonymous caller). */
async function call(
  h: Harness,
  method: string,
  path: string,
  opts: { session?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token ?? h.token}`,
      "content-type": "application/json",
      ...(opts.session ? { "x-kalo-session": opts.session } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("jobs endpoint", () => {
  test("publishes a readable descriptor and removes it on stop", () => {
    const h = makeServer();
    const ep = readEndpoint(h.dir);
    expect(ep?.url).toBe(h.url);
    expect(ep?.token).toBe(h.token);
    expect(ep?.pid).toBe(process.pid);
    expect(JSON.parse(readFileSync(endpointFile(h.dir), "utf-8")).token).toBe(h.token);

    h.server.stop();
    expect(readEndpoint(h.dir)).toBeNull();
  });

  test("rejects a missing or wrong token", async () => {
    const h = makeServer();
    const res = await fetch(`${h.url}/health`);
    expect(res.status).toBe(401);
    const wrong = await call(h, "GET", "/health", { token: "x".repeat(h.token.length) });
    expect(wrong.status).toBe(401);
    const ok = await call(h, "GET", "/health");
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  test("fences listing by the x-kalo-session header", async () => {
    const h = makeServer();
    h.backend.startCommand({ label: "a", cwd: h.dir, cmd: "exit 0", owner: "s-1", gate: { script: "exit 1", intervalSec: 60 } });
    h.backend.startCommand({ label: "b", cwd: h.dir, cmd: "exit 0", owner: "s-2", gate: { script: "exit 1", intervalSec: 60 } });

    const mine = await call(h, "GET", "/jobs", { session: "s-1" });
    expect(mine.body.jobs.map((j: any) => j.label)).toEqual(["a"]);

    // Anonymous sees only unowned jobs, and a foreign id reads as unknown.
    const anon = await call(h, "GET", "/jobs");
    expect(anon.body.jobs).toEqual([]);
    const foreign = await call(h, "GET", "/jobs/gateway-2", { session: "s-1" });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toContain("未知任务");
  });

  test("POST /jobs defaults the owner to the calling session", async () => {
    const h = makeServer();
    const created = await call(h, "POST", "/jobs", {
      session: "s-1",
      body: { label: "c", cwd: h.dir, cmd: "exit 0", gate: { script: "exit 1", intervalSec: 60 } },
    });
    expect(created.status).toBe(200);
    expect(created.body.job.ownerSession).toBe("s-1");
    expect(h.backend.list(OPERATOR)).toHaveLength(1);
  });

  test("kill goes through the registry and is idempotent", async () => {
    const h = makeServer();
    const id = h.backend.startCommand({
      label: "d",
      cwd: h.dir,
      cmd: "exit 0",
      owner: "s-1",
      gate: { script: "exit 1", intervalSec: 60 },
    });
    const first = await call(h, "POST", `/jobs/${id}/kill`, { session: "s-1", body: { reason: "手动停止" } });
    expect(first.body.result).toBe("requested");
    expect(first.body.job.status).toBe("killed");
    expect(first.body.job.detail).toBe("手动停止");

    const second = await call(h, "POST", `/jobs/${id}/kill`, { session: "s-1" });
    expect(second.body.result).toBe("already-finished");
  });

  test("completions are claimed once, by the owning session only", async () => {
    const h = makeServer();
    const id = h.backend.startCommand({ label: "e", cwd: h.dir, cmd: "exit 0", owner: "s-1" });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && h.backend.get(id, "s-1").status !== "completed") {
      h.backend.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(h.backend.get(id, "s-1").status).toBe("completed");

    // A foreign session must not drain someone else's notice...
    const foreign = await call(h, "POST", "/completions/claim", { session: "s-2", body: {} });
    expect(foreign.body.jobs).toEqual([]);

    // ...the owner gets it exactly once.
    const first = await call(h, "POST", "/completions/claim", { session: "s-1", body: {} });
    expect(first.body.jobs.map((j: any) => j.id)).toEqual([id]);
    const second = await call(h, "POST", "/completions/claim", { session: "s-1", body: {} });
    expect(second.body.jobs).toEqual([]);
  });

  test("output waits for settlement and returns the log delta", async () => {
    const h = makeServer();
    const id = h.backend.startCommand({ label: "h", cwd: h.dir, cmd: "echo one; echo two", owner: "s-1" });
    const deadline = Date.now() + 8000;
    let out: any;
    while (Date.now() < deadline) {
      h.backend.tick();
      out = await call(h, "POST", `/jobs/${id}/output`, { session: "s-1", body: { wait: true, timeoutMs: 200 } });
      if (out.body.text.includes("two")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(out.body.text).toContain("one");
    expect(out.body.text).toContain("two");
  });

  test("unknown routes are 404", async () => {
    const h = makeServer();
    expect((await call(h, "GET", "/nope")).status).toBe(404);
    expect((await call(h, "DELETE", "/jobs")).status).toBe(405);
  });
});
