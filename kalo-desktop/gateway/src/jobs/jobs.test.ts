import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, type JobRecord } from "./store";
import { GatewayJobBackend } from "./gateway-backend";
import { isTerminal } from "./types";

const T0 = Date.parse("2026-08-15T14:30:00");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kalo-jobs-test-"));
}

interface Harness {
  dir: string;
  backend: GatewayJobBackend;
  nowRef: { value: number };
  changes: number;
  cleanup: () => void;
}

function makeBackend(): Harness {
  const dir = tmp();
  const nowRef = { value: T0 };
  const h: Harness = {
    dir,
    nowRef,
    changes: 0,
    backend: null as unknown as GatewayJobBackend,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  h.backend = new GatewayJobBackend({
    store: new JobStore(dir),
    now: () => nowRef.value,
    onChange: () => {
      h.changes += 1;
    },
  });
  return h;
}

/** Poll until `cond` holds, ticking the backend so probes/settlement advance. */
async function waitFor(h: Harness, cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    h.nowRef.value += 5_000; // let interval-gated probes come due
    h.backend.tick();
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("waitFor timed out");
}

function baseRecord(dir: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    kind: "gateway",
    label: "训练",
    cwd: dir,
    cmd: "echo hi",
    logPath: join(dir, "j1.log"),
    status: "running",
    startedAt: T0,
    reported: false,
    logOffset: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Store: persistence round-trip, corrupt-file tolerance, metrics append
// ---------------------------------------------------------------------------

describe("JobStore", () => {
  test("save/load round-trip through raw JSON on disk", () => {
    const dir = tmp();
    try {
      const store = new JobStore(dir);
      store.save(baseRecord(dir, { ownerSession: "s1" }));

      const raw = JSON.parse(readFileSync(store.file("j1"), "utf-8"));
      expect(raw.id).toBe("j1");
      expect(raw.label).toBe("训练");
      expect(raw.status).toBe("running");

      const loaded = new JobStore(dir).loadAll();
      expect(loaded.length).toBe(1);
      expect(loaded[0].cmd).toBe("echo hi");
      expect(loaded[0].ownerSession).toBe("s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt job files are skipped, not fatal", () => {
    const dir = tmp();
    try {
      const store = new JobStore(dir);
      store.save(baseRecord(dir, { id: "good", status: "queued" }));
      writeFileSync(join(store.root(), "broken.json"), "{ not json");

      expect(new JobStore(dir).loadAll().map((r) => r.id)).toEqual(["good"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("metrics append and tail-read", () => {
    const dir = tmp();
    try {
      const store = new JobStore(dir);
      store.appendMetric("j1", { at: T0, metric: "loss", value: 0.5 });
      store.appendMetric("j1", { at: T0 + 1, metric: "loss", value: 0.25 });

      expect(store.readMetrics("j1").length).toBe(2);
      const tail = store.readMetrics("j1", 1);
      expect(tail.length).toBe(1);
      expect(tail[0].value).toBe(0.25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Backend: lifecycle, owner fencing, logs, gate, rules → metrics
// ---------------------------------------------------------------------------

describe("GatewayJobBackend", () => {
  test("a command job runs to completion and its output is readable", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({
        label: "echo",
        cwd: h.dir,
        cmd: "echo hello-jobs",
        owner: "s1",
      });

      await waitFor(h, () => isTerminal(h.backend.get(id, "s1").status));
      expect(h.backend.get(id, "s1").status).toBe("completed");
      expect(h.backend.read(id, "s1").text).toContain("hello-jobs");
    } finally {
      h.cleanup();
    }
  });

  test("a nonzero exit still settles (process gone → terminal)", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({
        label: "fail",
        cwd: h.dir,
        cmd: "exit 3",
        owner: "s1",
      });
      await waitFor(h, () => isTerminal(h.backend.get(id, "s1").status));
      expect(isTerminal(h.backend.get(id, "s1").status)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("owner fencing: a foreign caller sees the job as unknown", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({
        label: "sleeper",
        cwd: h.dir,
        cmd: "sleep 30",
        owner: "s1",
      });

      expect(() => h.backend.get(id, "s2")).toThrow();
      expect(() => h.backend.read(id, "s2")).toThrow();
      expect(() => h.backend.kill(id, "s2", "nope")).toThrow();
      expect(h.backend.list("s2")).toEqual([]);
      expect(h.backend.list("s1").map((s) => s.id)).toEqual([id]);

      expect(h.backend.kill(id, "s1", "done testing")).toBe("requested");
    } finally {
      h.cleanup();
    }
  });

  test("kill settles the job as killed", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({
        label: "sleeper",
        cwd: h.dir,
        cmd: "sleep 30",
        owner: "s1",
      });
      expect(h.backend.get(id, "s1").status).toBe("running");

      h.backend.kill(id, "s1", "用户叫停");
      await waitFor(h, () => isTerminal(h.backend.get(id, "s1").status));
      expect(h.backend.get(id, "s1").status).toBe("killed");
    } finally {
      h.cleanup();
    }
  });

  test("killing an already-finished job reports already-finished", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({ label: "quick", cwd: h.dir, cmd: "echo done", owner: "s1" });
      await waitFor(h, () => isTerminal(h.backend.get(id, "s1").status));
      expect(h.backend.kill(id, "s1")).toBe("already-finished");
    } finally {
      h.cleanup();
    }
  });

  test("a gate holds the job queued until its script passes", async () => {
    const h = makeBackend();
    try {
      const flag = join(h.dir, "go.txt").replace(/\\/g, "/");
      const id = h.backend.startCommand({
        label: "gated",
        cwd: h.dir,
        cmd: "echo launched",
        gate: { script: `test -f '${flag}'`, intervalSec: 1 },
        owner: "s1",
      });

      expect(h.backend.get(id, "s1").status).toBe("queued");
      h.nowRef.value += 5_000;
      h.backend.tick();
      await new Promise((r) => setTimeout(r, 300));
      expect(h.backend.get(id, "s1").status).toBe("queued");

      writeFileSync(join(h.dir, "go.txt"), "ok");
      await waitFor(h, () => isTerminal(h.backend.get(id, "s1").status));
      expect(h.backend.read(id, "s1").text).toContain("launched");
    } finally {
      h.cleanup();
    }
  });

  test("rules extract metrics from matching log lines", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({
        label: "metrics",
        cwd: h.dir,
        cmd: "echo 'step=1 loss=0.5'; echo 'step=2 loss=0.25'",
        rules: [{ match: "loss=([0-9.]+)", metric: "loss" }],
        owner: "s1",
      });

      await waitFor(h, () => h.backend.metrics(id, "s1").length >= 2);
      const losses = h.backend.metrics(id, "s1").map((m) => m.value);
      expect(losses).toEqual([0.5, 0.25]);
    } finally {
      h.cleanup();
    }
  });

  test("wait resolves with the terminal snapshot", async () => {
    const h = makeBackend();
    try {
      const id = h.backend.startCommand({ label: "waited", cwd: h.dir, cmd: "echo bye", owner: "s1" });
      const pending = h.backend.wait(id, 8000, "s1");
      await waitFor(h, () => isTerminal(h.backend.get(id, "s1").status));
      const snap = await pending;
      expect(isTerminal(snap.status)).toBe(true);
      expect(snap.id).toBe(id);
    } finally {
      h.cleanup();
    }
  });

  test("reload re-verifies a dead pid and settles the job", () => {
    const h = makeBackend();
    try {
      new JobStore(h.dir).save(
        baseRecord(h.dir, { id: "ghost", label: "ghost", status: "running", pid: 999_999 }),
      );

      const revived = new GatewayJobBackend({
        store: new JobStore(h.dir),
        now: () => h.nowRef.value,
        onChange: () => {},
      });
      revived.load();

      const snap = revived.get("ghost");
      expect(isTerminal(snap.status)).toBe(true);
      expect(snap.status).toBe("failed");
    } finally {
      h.cleanup();
    }
  });

  test("unknown job ids raise a clear error", () => {
    const h = makeBackend();
    try {
      expect(() => h.backend.get("nope")).toThrow(/未知任务/);
    } finally {
      h.cleanup();
    }
  });

  test("startCommand rejects an empty command", () => {
    const h = makeBackend();
    try {
      expect(() => h.backend.startCommand({ label: "x", cwd: h.dir, cmd: "  " })).toThrow();
    } finally {
      h.cleanup();
    }
  });
});
