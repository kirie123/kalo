/**
 * Gateway job backend (P0-1 §2) — the JobRegistry implementation whose work
 * outlives the session that started it.
 *
 * Why a second backend instead of running jobs in-session: the gateway itself
 * restarts on crash (MAX_RESTARTS=5) and is killed by Rust on unbind/shutdown,
 * so a job must NOT be a child of this process. Every job is spawned detached
 * (CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS on Windows) with its own output
 * redirected to logPath by the OS, and all state is on disk. A gateway restart
 * re-reads the store and re-verifies each `running` record's PID.
 *
 * kalo additions over dsh's protocol, all confined to this layer:
 *   gate   — pre-launch bash門: stay `queued` until it exits 0 (§2.2)
 *   health — periodic bash check while running; failure marks detail (§2.2)
 *   rules  — regex over new log bytes → <jobId>.metrics.jsonl (§2.4)
 *
 * No domain vocabulary appears here: gate/health/rules are user-authored.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../protocol";
import { JobStore, type JobRecord, type JobProbe, type JobRule } from "./store";
import {
  isTerminal,
  OPERATOR,
  type Caller,
  type JobDoneListener,
  type JobHooks,
  type JobRead,
  type JobRegistry,
  type JobSnapshot,
  type JobStart,
  type JobsChangedListener,
  type JobStatus,
} from "./types";

const TICK_MS = 5_000;
const PROBE_TIMEOUT_MS = 60_000;
const MAX_READ_BYTES = 256 * 1024;

/** Windows creation flags: detach fully so the gateway is not our parent job. */
const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
const DETACHED_PROCESS = 0x0000_0008;
const CREATE_NO_WINDOW = 0x0800_0000;

export interface JobBackendDeps {
  store?: JobStore;
  now?: () => number;
  /** Notified whenever a job's visible state changed (snapshot broadcast). */
  onChange?: () => void;
}

interface Waiter {
  resolve: (s: JobSnapshot) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayJobBackend implements JobRegistry {
  private records = new Map<string, JobRecord>();
  private counters = new Map<string, number>();
  private doneListeners = new Set<JobDoneListener>();
  private changedListeners = new Set<JobsChangedListener>();
  private waiters = new Map<string, Set<Waiter>>();
  /** Hooks for producer-driven jobs (start()); command jobs have no entry. */
  private producers = new Map<string, JobHooks>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: JobStore;
  private readonly now: () => number;

  constructor(private deps: JobBackendDeps = {}) {
    this.store = deps.store ?? new JobStore();
    this.now = deps.now ?? (() => Date.now());
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Restore from disk and re-verify reality (§2.5). A `running` record whose
   * PID is gone settles now — the process died while the gateway was away.
   */
  load(): void {
    this.records.clear();
    for (const rec of this.store.loadAll()) {
      this.records.set(rec.id, rec);
      const n = idSuffix(rec.id);
      if (n !== null) this.counters.set(rec.kind, Math.max(this.counters.get(rec.kind) ?? 0, n));
      if (rec.status === "running" || rec.status === "stopping") {
        if (!rec.pid || !isAlive(rec.pid)) {
          rec.status = "failed";
          rec.detail = rec.detail ?? "进程已不存在（网关重启后核对）";
          rec.finishedAt = rec.finishedAt ?? this.now();
          this.store.save(rec);
        }
      }
    }
    log(`jobs loaded ${this.records.size} record(s)`);
  }

  /**
   * Protocol-level start: register a producer-driven job. The producer owns its
   * own execution resources and reports through hooks, so nothing is spawned
   * here. Command-backed jobs use {@link startCommand} instead.
   */
  start(spec: JobStart): string {
    if (!spec.kind.trim()) throw new Error("任务需要 kind");
    if (!spec.label.trim()) throw new Error("任务需要 label");
    const n = (this.counters.get(spec.kind) ?? 0) + 1;
    this.counters.set(spec.kind, n);
    const id = `${spec.kind}-${n}`;

    const hooks = spec.run();
    const rec: JobRecord = {
      id,
      kind: spec.kind,
      label: spec.label.trim(),
      cwd: "",
      cmd: spec.label.trim(),
      logPath: this.store.defaultLogPath(id),
      status: "running",
      ownerSession: spec.owner,
      startedAt: this.now(),
      reported: false,
      logOffset: 0,
    };
    this.records.set(id, rec);
    this.producers.set(id, hooks);
    this.store.save(rec);
    this.changed(rec.ownerSession);

    hooks.done.then(
      (outcome) => this.settle(rec, outcome.status, outcome.detail),
      (err) => this.settle(rec, "failed", err instanceof Error ? err.message : String(err)),
    );
    return id;
  }

  /**
   * Register and launch a command-backed job. Returns the new job id.
   * A job with a `gate` starts `queued` and is launched by a later tick.
   */
  startCommand(input: {
    label: string;
    cwd: string;
    cmd: string;
    env?: Record<string, string>;
    gate?: JobProbe;
    health?: JobProbe;
    rules?: JobRule[];
    owner?: string;
    kind?: string;
  }): string {
    const kind = input.kind ?? "gateway";
    if (!input.cmd.trim()) throw new Error("任务需要 cmd");
    if (!input.label.trim()) throw new Error("任务需要 label");
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const id = `${kind}-${n}`;

    const rec: JobRecord = {
      id,
      kind,
      label: input.label.trim(),
      cwd: input.cwd,
      cmd: input.cmd,
      env: input.env,
      logPath: this.store.defaultLogPath(id),
      gate: input.gate,
      health: input.health,
      rules: input.rules,
      status: input.gate ? "queued" : "running",
      ownerSession: input.owner,
      startedAt: this.now(),
      reported: false,
      logOffset: 0,
    };
    this.records.set(id, rec);
    this.store.save(rec);

    if (!input.gate) this.launch(rec);
    this.changed(rec.ownerSession);
    return id;
  }

  startTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ reads

  list(caller?: Caller): JobSnapshot[] {
    return [...this.records.values()]
      .filter((r) => this.visible(r, caller))
      .map((r) => snapshot(r));
  }

  get(id: string, caller?: Caller): JobSnapshot {
    return snapshot(this.require(id, caller));
  }

  /** Consuming read of new output; a terminal read marks the job reported. */
  read(id: string, caller?: Caller): JobRead {
    const rec = this.require(id, caller);
    const hooks = this.producers.get(rec.id);
    const text = hooks?.readOutput ? hooks.readOutput() : this.consumeLog(rec);
    if (isTerminal(rec.status) && !rec.reported) {
      rec.reported = true;
      this.store.save(rec);
    }
    return { text, snapshot: snapshot(rec) };
  }

  metrics(id: string, caller?: Caller, tail?: number): Record<string, unknown>[] {
    this.require(id, caller);
    return this.store.readMetrics(id, tail);
  }

  /**
   * Terminal jobs this caller has not been told about yet, marked reported in
   * the same pass (§1.4). This is what turns "the model polls" into "the model
   * is notified": a session drains this instead of re-reading job state.
   */
  claimCompletions(caller?: Caller): JobSnapshot[] {
    // Only a real session drains its own notices; the operator must not claim
    // them, or the session that started the job would never hear about it.
    if (typeof caller !== "string") return [];
    const out: JobSnapshot[] = [];
    for (const rec of this.records.values()) {
      if (!isTerminal(rec.status) || rec.reported) continue;
      if (rec.ownerSession !== caller) continue;
      rec.reported = true;
      this.store.save(rec);
      out.push(snapshot(rec));
    }
    return out;
  }

  kill(id: string, caller?: Caller, reason?: string): "requested" | "already-finished" {
    const rec = this.require(id, caller);
    if (isTerminal(rec.status)) return "already-finished";
    if (rec.status === "queued") {
      // Never launched: settle directly, there is no process to signal.
      this.settle(rec, "killed", reason ?? "在门控等待时被取消");
      return "requested";
    }
    rec.status = "stopping";
    rec.reported = true;
    rec.detail = reason;
    this.store.save(rec);
    this.changed(rec.ownerSession);
    const hooks = this.producers.get(rec.id);
    if (hooks) {
      // A producer throw propagates without changing job state beyond stopping.
      hooks.cancel(reason);
    } else if (rec.pid) {
      killTree(rec.pid);
    }
    return "requested";
  }

  wait(id: string, timeoutMs: number, caller?: Caller, signal?: AbortSignal): Promise<JobSnapshot> {
    const rec = this.require(id, caller);
    if (isTerminal(rec.status)) return Promise.resolve(snapshot(rec));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error(`无效的等待时长：${timeoutMs}`));
    }
    return new Promise<JobSnapshot>((resolve, reject) => {
      const set = this.waiters.get(id) ?? new Set<Waiter>();
      this.waiters.set(id, set);
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          set.delete(waiter);
          resolve(snapshot(rec)); // Timeout keeps a live job alive (§1.3).
        }, timeoutMs),
      };
      set.add(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          if (isTerminal(rec.status)) return; // Settlement wins over a late abort.
          clearTimeout(waiter.timer);
          set.delete(waiter);
          reject(new Error("等待已取消"));
        },
        { once: true },
      );
    });
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.doneListeners.add(listener);
    return () => this.doneListeners.delete(listener);
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  // ------------------------------------------------------------------- tick

  /**
   * One pass: launch gate-passing queued jobs, verify running PIDs, run health
   * probes, and feed new log bytes through the rules.
   */
  tick(): void {
    for (const rec of [...this.records.values()]) {
      if (isTerminal(rec.status)) continue;
      if (rec.status === "queued") {
        this.tryGate(rec);
        continue;
      }
      // Producer-driven jobs settle through their own hooks.done.
      if (this.producers.has(rec.id)) continue;
      this.pumpRules(rec);
      if (rec.pid && !isAlive(rec.pid)) {
        const stopping = rec.status === "stopping";
        this.settle(rec, stopping ? "killed" : "completed", stopping ? rec.detail : undefined);
        continue;
      }
      if (rec.status === "running") this.tryHealth(rec);
    }
  }

  private tryGate(rec: JobRecord): void {
    const probe = rec.gate;
    if (!probe) {
      this.launch(rec);
      return;
    }
    const due = (rec.lastProbeAt ?? 0) + probe.intervalSec * 1000;
    if (this.now() < due) return;
    rec.lastProbeAt = this.now();
    this.store.save(rec);
    runProbe(probe.script, rec.cwd, (ok) => {
      if (rec.status !== "queued") return; // Killed or launched meanwhile.
      if (ok) this.launch(rec);
    });
  }

  private tryHealth(rec: JobRecord): void {
    const probe = rec.health;
    if (!probe) return;
    const due = (rec.lastProbeAt ?? 0) + probe.intervalSec * 1000;
    if (this.now() < due) return;
    rec.lastProbeAt = this.now();
    this.store.save(rec);
    runProbe(probe.script, rec.cwd, (ok) => {
      if (rec.status !== "running") return;
      const detail = ok ? undefined : "健康检查未通过";
      if (rec.detail !== detail) {
        rec.detail = detail;
        this.store.save(rec);
        this.changed(rec.ownerSession);
      }
    });
  }

  /** Spawn the detached process and record its PID. */
  private launch(rec: JobRecord): void {
    try {
      mkdirSync(dirname(rec.logPath), { recursive: true });
      // The child redirects its own output: the OS owns the file handle, so
      // logs survive this gateway process dying mid-job.
      const redirect = `exec >> ${shq(rec.logPath)} 2>&1\n${rec.cmd}`;
      const child = spawn("bash", ["-c", redirect], {
        cwd: existsSync(rec.cwd) ? rec.cwd : undefined,
        env: rec.env ? { ...process.env, ...rec.env } : process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        ...(process.platform === "win32"
          ? { windowsVerbatimArguments: false, creationFlags: CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NO_WINDOW }
          : {}),
      } as any);
      child.unref(); // Do not hold the gateway's event loop open.
      rec.pid = child.pid;
      rec.status = "running";
      rec.lastProbeAt = this.now();
      this.store.save(rec);
      this.changed(rec.ownerSession);
    } catch (err) {
      this.settle(rec, "failed", `无法启动：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Feed newly appended log bytes through the rules, extracting metrics. */
  private pumpRules(rec: JobRecord): void {
    if (!rec.rules?.length) return;
    const text = this.readLogFrom(rec, false);
    if (!text) return;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      for (const rule of rec.rules) {
        const m = new RegExp(rule.match).exec(line);
        if (!m) continue;
        const value = m[1] ?? m[0];
        const num = Number(value);
        this.store.appendMetric(rec.id, {
          at: this.now(),
          metric: rule.metric ?? "match",
          value: Number.isFinite(num) ? num : value,
        });
      }
    }
  }

  /** Consuming read used by both the model-facing read and the rules pump. */
  private consumeLog(rec: JobRecord): string {
    return this.readLogFrom(rec, true);
  }

  /**
   * Read from logOffset forward. Both callers advance the same cursor — one
   * consuming cursor per job (§1.3) — so the rules pump and a model read do
   * not double-consume; whichever runs first advances it.
   */
  private readLogFrom(rec: JobRecord, save: boolean): string {
    if (!existsSync(rec.logPath)) return "";
    let fd: number | undefined;
    try {
      const size = statSync(rec.logPath).size;
      const from = Math.min(rec.logOffset ?? 0, size);
      if (size <= from) return "";
      const len = Math.min(size - from, MAX_READ_BYTES);
      const buf = Buffer.allocUnsafe(len);
      fd = openSync(rec.logPath, "r");
      readSync(fd, buf, 0, len, from);
      rec.logOffset = from + len;
      if (save) this.store.save(rec);
      return buf.toString("utf-8");
    } catch {
      return "";
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // -------------------------------------------------------------- internals

  private settle(rec: JobRecord, status: Extract<JobStatus, "completed" | "killed" | "failed">, detail?: string): void {
    if (isTerminal(rec.status)) return; // First-wins.
    rec.status = status;
    rec.detail = detail ?? rec.detail;
    rec.finishedAt = this.now();
    this.producers.delete(rec.id);
    this.store.save(rec);

    const snap = snapshot(rec);
    const set = this.waiters.get(rec.id);
    if (set) {
      for (const w of set) {
        clearTimeout(w.timer);
        w.resolve(snap);
      }
      this.waiters.delete(rec.id);
      // A waiter observed the terminal state, so it counts as reported.
      rec.reported = true;
      this.store.save(rec);
    }
    this.changed(rec.ownerSession);
    // Announced last, after the record is committed and other observers saw it.
    for (const l of this.doneListeners) {
      try {
        l(snapshot(rec), rec.ownerSession);
      } catch (err) {
        log("job done listener failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  private changed(owner: string | undefined): void {
    this.deps.onChange?.();
    for (const l of this.changedListeners) {
      try {
        l(owner);
      } catch {
        /* contained */
      }
    }
  }

  private visible(rec: JobRecord, caller?: Caller): boolean {
    if (caller === OPERATOR) return true; // The user sees their own machine.
    if (rec.ownerSession === undefined) return true;
    return rec.ownerSession === caller;
  }

  private require(id: string, caller?: Caller): JobRecord {
    const rec = this.records.get(id);
    // Foreign jobs are reported as unknown: ids are predictable, so the
    // boundary is authorization, and a distinct error would leak existence.
    if (!rec || !this.visible(rec, caller)) throw new Error(`未知任务：${id}`);
    return rec;
  }
}

// ----------------------------------------------------------------- helpers

function snapshot(rec: JobRecord): JobSnapshot {
  return {
    id: rec.id,
    kind: rec.kind,
    label: rec.label,
    ownerSession: rec.ownerSession,
    status: rec.status,
    detail: rec.detail,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    reported: rec.reported,
  };
}

function idSuffix(id: string): number | null {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Single-quote a path for bash. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Liveness probe that does not signal the process. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // Alive but owned by another user.
  }
}

/** Terminate a job's whole process tree (the command may have spawned children). */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Run a user-authored bash probe; `ok` is "exited 0". */
function runProbe(script: string, cwd: string, done: (ok: boolean) => void): void {
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(ok);
  };
  const child = spawn("bash", ["-c", script], {
    cwd: existsSync(cwd) ? cwd : undefined,
    stdio: "ignore",
    windowsHide: true,
  });
  const timer = setTimeout(() => {
    child.kill();
    finish(false);
  }, PROBE_TIMEOUT_MS);
  child.on("error", () => finish(false));
  child.on("close", (code) => finish(code === 0));
}
