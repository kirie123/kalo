/**
 * On-disk job store (P0-1 §2.3).
 *
 * One file per job at ~/.kalo/agent/jobs/<jobId>.json, sibling of the
 * scheduler's schedules.json (pi_config.rs agent_dir() pattern). Atomic
 * tmp+rename writes, same convention as scheduler.ts.
 *
 * The gateway backend is the ONLY writer: neither the model nor the channel
 * touches these files ("文件即状态，但状态由工具写，不由模型手写").
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobStatus } from "./types";

/** A user-authored bash probe: gate (pre-launch) or health (while running). */
export interface JobProbe {
  /** bash snippet; exit code 0 means pass. */
  script: string;
  /** How often to re-run it, in seconds. */
  intervalSec: number;
}

/** A user-authored log rule: regex → extract a metric. */
export interface JobRule {
  /** Regex source; the first capture group is the value. */
  match: string;
  /** Metric name written to <jobId>.metrics.jsonl. */
  metric?: string;
}

/**
 * The persisted job record. `gate`/`health`/`rules` are entirely user-authored
 * bash and regex — no domain vocabulary (nvidia-smi, OOM, …) appears in this
 * file or anywhere else in the runtime.
 */
export interface JobRecord {
  id: string;
  kind: string;
  label: string;
  cwd: string;
  cmd: string;
  env?: Record<string, string>;
  /** Absolute path the detached process redirects its own output to. */
  logPath: string;
  gate?: JobProbe;
  health?: JobProbe;
  rules?: JobRule[];
  status: JobStatus;
  pid?: number;
  exitCode?: number;
  detail?: string;
  ownerSession?: string;
  startedAt: number;
  finishedAt?: number;
  reported: boolean;
  /** Byte offset consumed by the log tailer (drives rules + output reads). */
  logOffset?: number;
  /** Last time the gate/health probe ran (epoch ms). */
  lastProbeAt?: number;
}

export function jobsDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".kalo", "agent", "jobs");
}

export class JobStore {
  constructor(private readonly dir: string = jobsDir()) {}

  root(): string {
    return this.dir;
  }

  /** Absolute path of a job's record file. */
  file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Absolute path of a job's extracted metric stream. */
  metricsFile(id: string): string {
    return join(this.dir, `${id}.metrics.jsonl`);
  }

  /** Default log path for a new job. */
  defaultLogPath(id: string): string {
    return join(this.dir, `${id}.log`);
  }

  save(rec: JobRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.file(rec.id) + ".tmp";
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
    renameSync(tmp, this.file(rec.id));
  }

  /** Load every readable record; unparsable files are skipped, not fatal. */
  loadAll(): JobRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: JobRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      try {
        const rec = sanitizeRecord(JSON.parse(readFileSync(join(this.dir, name), "utf-8")));
        if (rec) out.push(rec);
      } catch {
        // Corrupt record: leave the file in place for inspection, skip it.
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Append one extracted metric sample. */
  appendMetric(id: string, entry: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.metricsFile(id), JSON.stringify(entry) + "\n", { flag: "a" });
  }

  /** Read the metric stream, newest last, at most `tail` entries. */
  readMetrics(id: string, tail?: number): Record<string, unknown>[] {
    const file = this.metricsFile(id);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
    const slice = tail && tail > 0 ? lines.slice(-tail) : lines;
    const out: Record<string, unknown>[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip a torn line rather than failing the whole read.
      }
    }
    return out;
  }

  remove(id: string): void {
    for (const f of [this.file(id), this.metricsFile(id)]) {
      try {
        rmSync(f, { force: true });
      } catch {
        // Best effort.
      }
    }
  }
}

const STATUSES: JobStatus[] = ["queued", "running", "stopping", "completed", "killed", "failed"];

/** Coerce untrusted JSON into a JobRecord; null when unusable. */
export function sanitizeRecord(raw: any): JobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !/^[\w.-]{1,128}$/.test(raw.id)) return null;
  if (typeof raw.cmd !== "string" || !raw.cmd.trim()) return null;
  if (typeof raw.logPath !== "string" || !raw.logPath.trim()) return null;
  if (!STATUSES.includes(raw.status)) return null;
  return {
    id: raw.id,
    kind: typeof raw.kind === "string" && raw.kind ? raw.kind : "gateway",
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : raw.cmd.trim(),
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    cmd: raw.cmd,
    env: isStringMap(raw.env) ? raw.env : undefined,
    logPath: raw.logPath,
    gate: sanitizeProbe(raw.gate),
    health: sanitizeProbe(raw.health),
    rules: Array.isArray(raw.rules) ? raw.rules.map(sanitizeRule).filter((r): r is JobRule => r !== null) : undefined,
    status: raw.status,
    pid: Number.isFinite(raw.pid) ? Number(raw.pid) : undefined,
    exitCode: Number.isFinite(raw.exitCode) ? Number(raw.exitCode) : undefined,
    detail: typeof raw.detail === "string" ? raw.detail : undefined,
    ownerSession: typeof raw.ownerSession === "string" && raw.ownerSession ? raw.ownerSession : undefined,
    startedAt: Number.isFinite(raw.startedAt) ? Number(raw.startedAt) : 0,
    finishedAt: Number.isFinite(raw.finishedAt) ? Number(raw.finishedAt) : undefined,
    reported: raw.reported === true,
    logOffset: Number.isFinite(raw.logOffset) ? Math.max(0, Number(raw.logOffset)) : undefined,
    lastProbeAt: Number.isFinite(raw.lastProbeAt) ? Number(raw.lastProbeAt) : undefined,
  };
}

function sanitizeProbe(raw: any): JobProbe | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.script !== "string" || !raw.script.trim()) return undefined;
  const every = Number.isFinite(raw.intervalSec) ? Math.max(1, Number(raw.intervalSec)) : 30;
  return { script: raw.script, intervalSec: every };
}

function sanitizeRule(raw: any): JobRule | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.match !== "string" || !raw.match) return null;
  try {
    new RegExp(raw.match);
  } catch {
    return null; // Unusable regex: drop the rule rather than crashing the tick.
  }
  return { match: raw.match, metric: typeof raw.metric === "string" && raw.metric ? raw.metric : undefined };
}

function isStringMap(v: any): v is Record<string, string> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}
