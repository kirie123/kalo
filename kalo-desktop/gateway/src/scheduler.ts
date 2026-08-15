/**
 * Cron/watch/agent task scheduler (P0-A, doc/kalo-personal-agent-roadmap.md §4).
 *
 * Lives inside the gateway sidecar: it is always running when the app is up
 * and already owns the Feishu push channel. Tasks persist to
 * ~/.kalo/agent/schedules.json (atomic tmp+rename writes).
 *
 *   watch — run a bash snippet locally; non-empty stdout pushes an alert.
 *           Zero tokens, high frequency friendly. 60s hard timeout.
 *   agent — emit a session_request upstream; the Rust side spawns a headless
 *           pi session whose progress renders through the normal event chain.
 *
 * Design notes (roadmap §9):
 *   - pure-ish core: clock is injectable, tick() is explicit and testable
 *   - sleep/wake-up miss: nextRunAt in the past fires once, then reschedules
 *     from now (catch up at most once)
 *   - watch cooldown: after an alert the task is skipped until cooldownMin
 *     elapses (no re-alert storms)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./protocol";

// ---------------------------------------------------------------------------
// Task model (mirrors ~/.kalo/agent/schedules.json)
// ---------------------------------------------------------------------------

export type TaskKind = "watch" | "agent";
export type TaskResult = "ok" | "alerted" | "error";

export interface ScheduleTask {
  id: string;
  name: string;
  kind: TaskKind;
  /** 5-field cron, local timezone: "M H DoM Mon DoW". */
  schedule: string;
  cwd: string;
  /** watch: bash snippet. */
  script?: string;
  /** watch: currently only "nonEmpty" (alert when stdout is non-empty). */
  matchMode?: "nonEmpty";
  /** watch: minutes to skip the task after an alert. */
  cooldownMin?: number;
  /** agent: prompt for the headless pi session. */
  prompt?: string;
  /** agent: "provider/modelId", null/undefined = current default model. */
  model?: string | null;
  enabled: boolean;
  lastRun?: string;
  lastResult?: TaskResult;
}

/** Snapshot row sent upstream (task + computed next run for the UI). */
export interface ScheduleTaskInfo extends ScheduleTask {
  nextRunAt: string | null;
}

interface RuntimeState {
  nextRunAt: number | null;
  /** watch: last time an alert was pushed (drives cooldown). */
  lastAlertAt: number;
  /** re-entrancy guard: a task never overlaps with itself. */
  running: boolean;
}

const TICK_MS = 30_000;
const WATCH_TIMEOUT_MS = 60_000;
const MAX_ALERT_OUTPUT = 1500;
const MAX_BUFFER = 256 * 1024;

const agentDir = join(homedir(), ".kalo", "agent");
const storeFile = join(agentDir, "schedules.json");

// ---------------------------------------------------------------------------
// Minimal 5-field cron (numeric; "*", "*/n", "a", "a-b", "a-b/n", lists).
// DOM/DOW follow the Vixie rule: when both are restricted, either matching
// is enough. Times are local wall-clock minutes.
// ---------------------------------------------------------------------------

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number> | null; // null = "*"
  month: Set<number>;
  dow: Set<number> | null; // null = "*"; 0/7 = Sunday
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`无法解析的 cron 片段："${part}"`);
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? max : lo;
    }
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`cron 数值越界："${part}"（允许 ${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 需要 5 个字段（分 时 日 月 周），实际 ${fields.length} 个`);
  }
  const domRaw = fields[2].trim();
  const dowRaw = fields[4].trim();
  const dow = dowRaw === "*" ? null : parseField(dowRaw, 0, 7);
  if (dow?.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: domRaw === "*" ? null : parseField(domRaw, 1, 31),
    month: parseField(fields[3], 1, 12),
    dow,
  };
}

function cronMatches(spec: CronSpec, d: Date): boolean {
  return (
    spec.minute.has(d.getMinutes()) &&
    spec.hour.has(d.getHours()) &&
    spec.month.has(d.getMonth() + 1) &&
    (spec.dom === null && spec.dow === null
      ? true
      : spec.dom !== null && spec.dow !== null
        ? spec.dom.has(d.getDate()) || spec.dow.has(d.getDay())
        : spec.dom !== null
          ? spec.dom.has(d.getDate())
          : spec.dow!.has(d.getDay()))
  );
}

/** Next fire time strictly after `from`, or null when nothing matches
 *  within a year (e.g. Feb 30). */
export function nextCronTime(expr: string, from: Date = new Date()): Date | null {
  const spec = parseCron(expr);
  const t = new Date(from.getTime() + 60_000);
  t.setSeconds(0, 0);
  // Minute-stepping with cheap per-day short-circuits; at most ~1 year ahead.
  for (let day = 0; day < 366; day++) {
    if (!cronMatches({ ...spec, minute: allMinutes, hour: allHours }, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    for (let min = 0; min < 24 * 60; min++) {
      if (cronMatches(spec, t)) return new Date(t);
      t.setTime(t.getTime() + 60_000);
    }
  }
  return null;
}

const allMinutes = new Set(Array.from({ length: 60 }, (_, i) => i));
const allHours = new Set(Array.from({ length: 24 }, (_, i) => i));

/** Human-readable validation error, or null when the expression is usable. */
export function validateCron(expr: string): string | null {
  try {
    if (nextCronTime(expr) === null) return "未来一年内没有触发时间（检查日期字段）";
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  /** Push a watch alert to the user (Feishu text). May be offline-capable. */
  sendAlert: (task: ScheduleTask, output: string) => void;
  /** Ask upstream (Rust) to spawn a headless pi session for an agent task. */
  requestAgentSession: (task: ScheduleTask) => void;
  /** Called whenever the task table changes (snapshot broadcast hook). */
  onChange: () => void;
  now?: () => number;
  /** Override the schedules.json path (tests). */
  storeFile?: string;
}

export class Scheduler {
  private tasks = new Map<string, ScheduleTask>();
  private runtime = new Map<string, RuntimeState>();
  /** agent tasks awaiting their session bookkeeping: taskId → sessionId. */
  private pendingSessions = new Map<string, string>();
  private sessionToTask = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly storeFile: string;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.storeFile = deps.storeFile ?? storeFile;
  }

  load(): void {
    this.tasks.clear();
    this.runtime.clear();
    try {
      const data = JSON.parse(readFileSync(this.storeFile, "utf-8"));
      const list: unknown[] = Array.isArray(data?.tasks) ? data.tasks : [];
      for (const raw of list) {
        const task = sanitizeTask(raw);
        if (!task) continue;
        this.tasks.set(task.id, task);
        this.runtime.set(task.id, this.freshRuntime(task));
      }
    } catch {
      // Missing/corrupt file starts empty; the next save rewrites it.
    }
    log(`scheduler loaded ${this.tasks.size} task(s)`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): ScheduleTaskInfo[] {
    return [...this.tasks.values()].map((t) => ({
      ...t,
      nextRunAt: t.enabled ? isoOrNull(this.runtime.get(t.id)?.nextRunAt) : null,
    }));
  }

  /** Insert or replace a task. Returns an error string on invalid input. */
  upsert(raw: unknown): string | null {
    const task = sanitizeTask(raw);
    if (!task) return "任务格式不正确（缺 id/name/cwd 或类型字段）";
    const err = validateCron(task.schedule);
    if (err) return `cron 无效：${err}`;
    if (task.kind === "watch" && !task.script?.trim()) return "watch 任务需要 script";
    if (task.kind === "agent" && !task.prompt?.trim()) return "agent 任务需要 prompt";
    this.tasks.set(task.id, task);
    this.runtime.set(task.id, this.freshRuntime(task));
    this.save();
    this.deps.onChange();
    return null;
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.runtime.delete(id);
    this.save();
    this.deps.onChange();
  }

  /** Manual "run now": ignores enabled and cooldown (debug tool). */
  runNow(id: string): string | null {
    const task = this.tasks.get(id);
    if (!task) return `未知任务：${id}`;
    this.execute(task);
    return null;
  }

  /** One scheduler pass: fire tasks whose nextRunAt has arrived. */
  tick(): void {
    const now = this.now();
    for (const task of this.tasks.values()) {
      const rt = this.runtime.get(task.id);
      if (!rt || !task.enabled || rt.nextRunAt === null) continue;
      if (rt.nextRunAt > now) continue;
      // Reschedule first: a sleep/wake gap collapses into this single run.
      rt.nextRunAt = this.nextRun(task);
      this.execute(task);
    }
  }

  /** Rust confirmed the headless session for an agent task. */
  handleSessionStarted(taskId: string, sessionId: string): void {
    this.pendingSessions.delete(taskId);
    this.sessionToTask.set(sessionId, taskId);
  }

  /** Rust failed to spawn the headless session for an agent task. */
  handleSessionStartFailed(taskId: string, error: string): void {
    this.pendingSessions.delete(taskId);
    const task = this.tasks.get(taskId);
    if (task) this.finishRun(task, "error");
    log(`agent task ${taskId} failed to start: ${error}`);
  }

  /** Engine exit for any session; settles agent-task bookkeeping. */
  handleSessionExit(sessionId: string, code: number | null): void {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return;
    this.sessionToTask.delete(sessionId);
    const task = this.tasks.get(taskId);
    if (task) this.finishRun(task, code === 0 ? "ok" : "error");
  }

  // ------------------------------------------------------------------ //

  private freshRuntime(task: ScheduleTask): RuntimeState {
    const prev = this.runtime.get(task.id);
    return {
      nextRunAt: this.nextRun(task),
      lastAlertAt: prev?.lastAlertAt ?? 0,
      running: false,
    };
  }

  private nextRun(task: ScheduleTask): number | null {
    try {
      return nextCronTime(task.schedule, new Date(this.now()))?.getTime() ?? null;
    } catch {
      return null;
    }
  }

  private execute(task: ScheduleTask): void {
    const rt = this.runtime.get(task.id);
    if (!rt || rt.running) return;
    if (task.kind === "watch") {
      const cooldownMs = (task.cooldownMin ?? 0) * 60_000;
      if (cooldownMs > 0 && this.now() - rt.lastAlertAt < cooldownMs) return;
      this.runWatch(task, rt);
    } else {
      this.runAgent(task, rt);
    }
  }

  private runWatch(task: ScheduleTask, rt: RuntimeState): void {
    rt.running = true;
    task.lastRun = new Date(this.now()).toISOString();

    const child = spawn("bash", ["-c", task.script ?? ""], {
      cwd: existsSync(task.cwd) ? task.cwd : undefined,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rt.running = false;
      this.finishRun(task, "error");
      this.deps.sendAlert(task, `⏱️ 脚本执行超过 ${WATCH_TIMEOUT_MS / 1000}s，已强制终止`);
    }, WATCH_TIMEOUT_MS);

    child.stdout?.on("data", (c) => {
      if (out.length < MAX_BUFFER) out += c.toString();
    });
    child.stderr?.on("data", (c) => {
      if (err.length < MAX_BUFFER) err += c.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      rt.running = false;
      this.finishRun(task, "error");
      this.deps.sendAlert(task, `❌ 脚本无法启动：${e.message}（需要系统可用 bash）`);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      rt.running = false;
      const output = out.trim();
      if (output) {
        // Exit code is deliberately ignored: grep exits 1 on "no match",
        // which is the normal silent path for matchMode "nonEmpty".
        rt.lastAlertAt = this.now();
        this.finishRun(task, "alerted");
        const body = output.length > MAX_ALERT_OUTPUT ? output.slice(0, MAX_ALERT_OUTPUT) + "\n…(截断)" : output;
        this.deps.sendAlert(task, body);
      } else if (err.trim() && !out) {
        this.finishRun(task, "error");
        this.deps.sendAlert(task, `❌ 脚本异常（无输出，stderr）：\n${err.trim().slice(0, MAX_ALERT_OUTPUT)}`);
      } else {
        this.finishRun(task, "ok");
      }
    });
  }

  private runAgent(task: ScheduleTask, rt: RuntimeState): void {
    rt.running = true;
    task.lastRun = new Date(this.now()).toISOString();
    this.pendingSessions.set(task.id, "");
    this.deps.requestAgentSession(task);
    // rt.running is released by handleSessionExit / handleSessionStartFailed;
    // the timeout below guarantees release even if upstream never answers.
    setTimeout(() => {
      if (this.pendingSessions.has(task.id)) {
        this.pendingSessions.delete(task.id);
        rt.running = false;
        this.finishRun(task, "error");
        log(`agent task ${task.id}: session_request timed out`);
      }
    }, 120_000);
  }

  private finishRun(task: ScheduleTask, result: TaskResult): void {
    const rt = this.runtime.get(task.id);
    if (rt) rt.running = false;
    task.lastRun = task.lastRun ?? new Date(this.now()).toISOString();
    task.lastResult = result;
    this.save();
    this.deps.onChange();
  }

  private save(): void {
    mkdirSync(dirname(this.storeFile), { recursive: true });
    const tmp = this.storeFile + ".tmp";
    writeFileSync(tmp, JSON.stringify({ tasks: [...this.tasks.values()] }, null, 2) + "\n");
    renameSync(tmp, this.storeFile);
  }
}

function isoOrNull(ts: number | null | undefined): string | null {
  return ts ? new Date(ts).toISOString() : null;
}

/** Coerce untrusted JSON into a ScheduleTask; null when unusable. */
function sanitizeTask(raw: any): ScheduleTask | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (raw.kind !== "watch" && raw.kind !== "agent") return null;
  if (typeof raw.schedule !== "string") return null;
  if (typeof raw.cwd !== "string" || !raw.cwd.trim()) return null;
  return {
    id: raw.id,
    name: raw.name.trim(),
    kind: raw.kind,
    schedule: raw.schedule.trim(),
    cwd: raw.cwd,
    script: typeof raw.script === "string" ? raw.script : undefined,
    matchMode: "nonEmpty",
    cooldownMin: Number.isFinite(raw.cooldownMin) ? Math.max(0, Number(raw.cooldownMin)) : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
    enabled: raw.enabled !== false,
    lastRun: typeof raw.lastRun === "string" ? raw.lastRun : undefined,
    lastResult: ["ok", "alerted", "error"].includes(raw.lastResult) ? raw.lastResult : undefined,
  };
}
