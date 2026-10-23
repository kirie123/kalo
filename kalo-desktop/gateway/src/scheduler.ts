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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { log } from "./protocol";
import { terminateProcessTree } from "./process-tree";

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
  /** Digital expert this task belongs to (its sessions get identity + isolated memory). */
  expertId?: string;
  /** ISO timestamp of the last run. */
  lastRun?: string;
  lastResult?: TaskResult;
  /**
   * Last alert body / error summary (same text that was pushed), so the
   * desktop run panel can explain what "alerted" meant after the fact.
   * Cleared on a clean watch run. Persisted in schedules.json.
   */
  lastOutput?: string;
  enabled: boolean;
}

/** Snapshot row sent upstream (task + computed next run for the UI). */
export interface ScheduleTaskInfo extends ScheduleTask {
  nextRunAt: string | null;
  /** True while this task's run is in flight (watch child alive / agent session open). */
  running: boolean;
}

interface RuntimeState {
  nextRunAt: number | null;
  /** watch: last time an alert was pushed (drives cooldown). */
  lastAlertAt: number;
  /** re-entrancy guard: a task never overlaps with itself. */
  running: boolean;
  cancel?: () => void;
  error?: string;
}

interface AgentAttempt {
  task: ScheduleTask;
  runtime: RuntimeState;
  timer: ReturnType<typeof setTimeout>;
}

const TICK_MS = 30_000;
const WATCH_TIMEOUT_MS = 60_000;
const MAX_ALERT_OUTPUT = 1500;
const MAX_BUFFER = 256 * 1024;

const agentDir = join(homedir(), ".kalo", "agent");
const storeFile = join(agentDir, "schedules.json");

/**
 * A bash that can run our snippets.
 *
 * Two traps on Windows, both of which this order is shaped around:
 *
 * 1. The `bash` on PATH is frequently **WSL's** (`System32\bash.exe`), which
 *    sees a different filesystem and cannot run a script that talks about
 *    `C:\Users\...`. `scripts/ensure-engine.mjs` hit this first.
 * 2. `Git\bin\bash.exe` is a 44KB **wrapper** that launches the real shell
 *    (`Git\usr\bin\bash.exe`, 1.9MB) as a child. For a build script that
 *    just waits, the extra layer is harmless — but here children are
 *    long-lived, detached and killable, and the wrapper means `child.kill()`
 *    kills the wrapper while the shell keeps running (and keeps holding its
 *    cwd). So the real shell is preferred over the wrapper.
 *
 * Not cached: a user who installs Git for Windows to fix a failing watch task
 * should not have to restart the gateway.
 */
export function resolveBash(): string {
  for (const v of [process.env.KALO_BASH, process.env.BASH]) {
    if (v && v.trim() && existsSync(v)) return v;
  }
  if (process.platform !== "win32") return "bash";
  const onPath = pathBash();
  if (onPath) return onPath;
  for (const p of [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ]) {
    if (existsSync(p)) return p;
  }
  return "bash";
}

/**
 * Prepend the shell's own directory to the env's PATH. Pure, so it is
 * testable without spawning anything.
 *
 * Spawning the real shell (`Git\usr\bin\bash.exe`) directly — unlike the
 * `Git\bin\bash.exe` wrapper — does not add `/usr/bin` to PATH. On a machine
 * where Git is not on PATH (a desktop app launched from Explorer is the
 * normal case), every coreutil in a job (`tail`, `rm`, `ls`, …) then answers
 * "command not found". `resolveBash()` deliberately prefers the real shell
 * (see its comment above), so the spawn env has to carry the shell's dir.
 *
 * A non-absolute `shell` (plain `"bash"` resolved from PATH on unix) has no
 * directory of its own to add; the env is returned untouched.
 */
export function prependShellDir(env: NodeJS.ProcessEnv, shell: string): NodeJS.ProcessEnv {
  if (!isAbsolute(shell)) return env;
  const dir = dirname(shell);
  // Windows spells it `Path` in some processes; update the existing key so
  // the child cannot end up with two case-variant PATH entries.
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const current = env[key] ?? "";
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
}

/**
 * Spawn env for every bash this gateway starts (jobs, job probes, watch
 * tasks). `extra` is the per-job env (the engine's PATH, PI_* session vars)
 * and wins over `process.env` — but the shell's dir is prepended *after*
 * that merge, so neither source can push the coreutils back out of reach
 * (the engine's own PATH has no Git dirs either; only the wrapper adds them).
 */
export function bashSpawnEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = extra ? { ...process.env, ...extra } : { ...process.env };
  return prependShellDir(merged, resolveBash());
}

/** First `bash.exe` on PATH that is not WSL's launcher. */
function pathBash(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir.trim() || /system32/i.test(dir)) continue;
    const p = join(dir, "bash.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Tasks written on first run, so a fresh install is not an empty table.
 *
 * Only one entry, and it earns its place: `macro append` is what builds
 * `~/.kalo/market/daily.jsonl`, and every percentile the macro-pulse skill
 * reports is computed against that history. A user who has to discover the
 * task page first loses the first weeks of data permanently — history is the
 * one thing that cannot be backfilled.
 *
 * It costs zero tokens by design: `macro append` is silent on success, and a
 * watch task only alerts on non-empty stdout.
 */
export const DEFAULT_TASKS: ScheduleTask[] = [
  {
    id: "market-daily-snapshot",
    name: "宏观快照每日落盘",
    kind: "watch",
    // 收盘之后，且刻意避开整点——整点是所有人的默认值。
    schedule: "12 17 * * 1-5",
    cwd: join(homedir(), ".kalo", "market"),
    // 走 ~/.kalo/market/py 这个 shim，而不是写死某个解释器路径：
    // 哪个 Python 由 shim 在运行时决定（见 src-tauri/src/market_env.rs）。
    script: '"$HOME/.kalo/market/py" "$HOME/.kalo/skills/market-data/md.py" macro append',
    matchMode: "nonEmpty",
    // 环境没就绪时 shim 走 stderr + exit 1，会告警一次；一天最多一次。
    cooldownMin: 1440,
    enabled: true,
  },
];

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
  requestAgentSession: (task: ScheduleTask, requestId: string) => void;
  /** Called whenever the task table changes (snapshot broadcast hook). */
  onChange: () => void;
  now?: () => number;
  /** Override the schedules.json path (tests). */
  storeFile?: string;
  agentStartTimeoutMs?: number;
  watchTimeoutMs?: number;
}

export class Scheduler {
  private tasks = new Map<string, ScheduleTask>();
  private runtime = new Map<string, RuntimeState>();
  /** agent tasks awaiting their session bookkeeping: taskId → sessionId. */
  private pendingSessions = new Map<string, AgentAttempt>();
  private sessionToTask = new Map<string, AgentAttempt>();
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

  /**
   * Write the bundled default tasks, once, on a machine that has never had a
   * schedules.json.
   *
   * The guard is "the file does not exist", **not** "the table is empty":
   * a user who deletes the seeded task must not find it back on next launch.
   * Same reasoning as `feeds.seedExamples()`, which guards on the directory
   * rather than on the spec count.
   */
  seedDefaults(): void {
    if (existsSync(this.storeFile)) return;
    for (const task of DEFAULT_TASKS) {
      this.tasks.set(task.id, { ...task });
      this.runtime.set(task.id, this.freshRuntime(task));
    }
    this.save();
    log(`scheduler seeded ${DEFAULT_TASKS.length} default task(s)`);
    this.deps.onChange();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const attempt of this.pendingSessions.values()) clearTimeout(attempt.timer);
    this.pendingSessions.clear();
    for (const rt of this.runtime.values()) rt.cancel?.();
  }

  list(): ScheduleTaskInfo[] {
    return [...this.tasks.values()].map((t) => ({
      ...t,
      nextRunAt: t.enabled ? isoOrNull(this.runtime.get(t.id)?.nextRunAt) : null,
      running: this.runtime.get(t.id)?.running ?? false,
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
    const previous = this.tasks.get(task.id);
    if (previous) {
      task.lastRun = previous.lastRun;
      task.lastResult = previous.lastResult;
      task.lastOutput = previous.lastOutput;
    }
    const nextTasks = new Map(this.tasks).set(task.id, task);
    try { this.save(nextTasks); } catch (error) { return `保存任务失败：${error instanceof Error ? error.message : String(error)}`; }
    // Keep the object captured by a running callback and its re-entrancy lock alive.
    const active = previous ? Object.assign(previous, task) : task;
    this.tasks.set(task.id, active);
    const rt = this.runtime.get(task.id);
    if (rt) rt.nextRunAt = this.nextRun(active);
    else this.runtime.set(task.id, this.freshRuntime(active));
    this.deps.onChange();
    return null;
  }

  remove(id: string): void {
    this.save(new Map([...this.tasks].filter(([key]) => key !== id)));
    this.runtime.get(id)?.cancel?.();
    for (const [key, attempt] of this.pendingSessions) {
      if (attempt.task.id === id) { clearTimeout(attempt.timer); this.pendingSessions.delete(key); }
    }
    this.tasks.delete(id);
    this.runtime.delete(id);
    this.deps.onChange();
  }

  /** Manual "run now": ignores enabled and cooldown (debug tool). */
  runNow(id: string): string | null {
    const task = this.tasks.get(id);
    if (!task) return `未知任务：${id}`;
    if (this.runtime.get(id)?.running) return "任务正在运行，请等待当前执行完成";
    this.execute(task, true);
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
  handleSessionStarted(requestId: string, sessionId: string): boolean {
    const attempt = this.pendingSessions.get(requestId);
    if (!attempt) return false;
    clearTimeout(attempt.timer);
    this.pendingSessions.delete(requestId);
    this.sessionToTask.set(sessionId, attempt);
    return true;
  }

  /** Rust failed to spawn the headless session for an agent task. */
  handleSessionStartFailed(requestId: string, error: string): void {
    const attempt = this.pendingSessions.get(requestId);
    if (!attempt) return;
    clearTimeout(attempt.timer);
    this.pendingSessions.delete(requestId);
    attempt.task.lastOutput = `agent 会话启动失败：${error}`;
    this.finishRun(attempt.task, "error");
  }

  /** RPC sessions stay alive after a run. Only agent_settled finishes retries and continuations. */
  ownsSession(sessionId: string): boolean {
    const attempt = this.sessionToTask.get(sessionId);
    return Boolean(attempt && this.tasks.get(attempt.task.id) === attempt.task);
  }

  handleEvent(sessionId: string, payload: unknown): boolean {
    const attempt = this.sessionToTask.get(sessionId);
    if (!attempt || !payload || typeof payload !== "object") return false;
    const event = payload as { type?: string; id?: string; success?: boolean; error?: string; messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> };
    if (event.type === "response" && event.success === false && /^(sched-model-|sched-prompt-)/.test(event.id ?? "")) {
      this.sessionToTask.delete(sessionId);
      attempt.task.lastOutput = `agent 请求失败：${event.error || "请检查模型与任务配置"}`;
      this.finishRun(attempt.task, "error");
      return true;
    }
    if (event.type === "agent_end") {
      const last = Array.isArray(event.messages) ? [...event.messages].reverse().find((message) => message?.role === "assistant") : undefined;
      attempt.runtime.error = last?.stopReason === "error" || last?.stopReason === "aborted" ? last.errorMessage || "agent 执行失败或已中止" : undefined;
    }
    if (event.type !== "agent_settled") return false;
    this.sessionToTask.delete(sessionId);
    attempt.task.lastOutput = attempt.runtime.error;
    this.finishRun(attempt.task, attempt.runtime.error ? "error" : "ok");
    return true;
  }

  /** Engine exit for any session; settles agent-task bookkeeping. */
  handleSessionExit(sessionId: string, code: number | null): void {
    const attempt = this.sessionToTask.get(sessionId);
    if (!attempt) return;
    this.sessionToTask.delete(sessionId);
    attempt.task.lastOutput = `agent 在完成前退出（code=${code ?? "未知"}）`;
    this.finishRun(attempt.task, "error");
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

  private execute(task: ScheduleTask, manual = false): void {
    const rt = this.runtime.get(task.id);
    if (!rt || rt.running) return;
    if (task.kind === "watch") {
      const cooldownMs = (task.cooldownMin ?? 0) * 60_000;
      if (!manual && cooldownMs > 0 && this.now() - rt.lastAlertAt < cooldownMs) return;
      this.runWatch(task, rt);
    } else {
      rt.error = undefined;
      this.runAgent(task, rt);
    }
  }

  private runWatch(task: ScheduleTask, rt: RuntimeState): void {
    rt.running = true;
    task.lastRun = new Date(this.now()).toISOString();
    this.deps.onChange();

    try { if (!statSync(task.cwd).isDirectory()) throw new Error("不是文件夹"); }
    catch {
      rt.lastAlertAt = this.now();
      task.lastOutput = `工作目录不可用：${task.cwd}，请修正目录后重试`;
      this.finishRun(task, "error");
      this.deps.sendAlert(task, task.lastOutput);
      return;
    }

    const child = spawn(resolveBash(), ["-c", task.script ?? ""], {
      cwd: task.cwd,
      // The real shell needs its own dir on PATH for coreutils; see
      // `prependShellDir`.
      env: bashSpawnEnv(),
      windowsHide: true,
      detached: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Cooldown applies to failures too, not just to matches: a task whose
      // environment is broken fails on *every* tick, and without this a
      // 5-minute task pushes 288 identical alerts a day.
      rt.lastAlertAt = this.now();
      let body = `脚本执行超时（${(this.deps.watchTimeoutMs ?? WATCH_TIMEOUT_MS) / 1000}s），已请求终止`;
      const stopping = child.pid ? terminateProcessTree(child.pid) : Promise.resolve();
      void stopping.catch((error: unknown) => { body += `\n停止失败，请检查进程：${String(error)}`; }).then(() => {
        task.lastOutput = body;
        if (this.finishRun(task, "error")) this.deps.sendAlert(task, body);
      });
    }, this.deps.watchTimeoutMs ?? WATCH_TIMEOUT_MS);
    rt.cancel = () => { settled = true; clearTimeout(killTimer); if (child.pid) void terminateProcessTree(child.pid).catch((error) => log("watch termination failed", error)); };

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
      rt.lastAlertAt = this.now();
      const body = `❌ 脚本无法启动：${e.message}（需要系统可用 bash）`;
      task.lastOutput = body;
      if (this.finishRun(task, "error")) this.deps.sendAlert(task, body);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      rt.cancel = undefined;
      if (this.tasks.get(task.id) !== task) return;
      rt.running = false;
      const output = out.trim();
      if (output) {
        // Exit code is deliberately ignored: grep exits 1 on "no match",
        // which is the normal silent path for matchMode "nonEmpty".
        rt.lastAlertAt = this.now();
        const body = output.length > MAX_ALERT_OUTPUT ? output.slice(0, MAX_ALERT_OUTPUT) + "\n…(截断)" : output;
        task.lastOutput = body;
        this.finishRun(task, "alerted");
        this.deps.sendAlert(task, body);
      } else if (err.trim() && !out) {
        rt.lastAlertAt = this.now();
        const body = `❌ 脚本异常（无输出，stderr）：\n${err.trim().slice(0, MAX_ALERT_OUTPUT)}`;
        task.lastOutput = body;
        this.finishRun(task, "error");
        this.deps.sendAlert(task, body);
      } else {
        // A clean watch run has nothing to say; stale alert text would mislead.
        task.lastOutput = undefined;
        this.finishRun(task, "ok");
      }
    });
  }

  private runAgent(task: ScheduleTask, rt: RuntimeState): void {
    rt.running = true;
    task.lastRun = new Date(this.now()).toISOString();
    this.deps.onChange();
    const requestId = `schedule:${task.id}:${randomUUID()}`;
    // rt.running is released by handleSessionExit / handleSessionStartFailed;
    // the timeout below guarantees release even if upstream never answers.
    const timer = setTimeout(() => {
      if (this.pendingSessions.has(requestId)) {
        this.pendingSessions.delete(requestId);
        rt.running = false;
        task.lastOutput = "agent 会话启动超时（120s 无响应）";
        this.finishRun(task, "error");
        log(`agent task ${task.id}: session_request timed out`);
      }
    }, this.deps.agentStartTimeoutMs ?? 120_000);
    timer.unref();
    this.pendingSessions.set(requestId, { task, runtime: rt, timer });
    try { this.deps.requestAgentSession({ ...task }, requestId); }
    catch (error) { this.handleSessionStartFailed(requestId, error instanceof Error ? error.message : String(error)); }
  }

  private finishRun(task: ScheduleTask, result: TaskResult): boolean {
    if (this.tasks.get(task.id) !== task) return false;
    const rt = this.runtime.get(task.id);
    if (rt) { rt.running = false; rt.cancel = undefined; }
    task.lastRun = task.lastRun ?? new Date(this.now()).toISOString();
    task.lastResult = result;
    try { this.save(); }
    catch (error) {
      task.lastResult = "error";
      task.lastOutput = `${task.lastOutput ?? ""}\n执行结果未能保存，请检查磁盘空间和目录权限：${String(error)}`.trim();
      log("cannot persist task result", error);
    }
    this.deps.onChange();
    return true;
  }

  private save(tasks = this.tasks): void {
    mkdirSync(dirname(this.storeFile), { recursive: true });
    const tmp = this.storeFile + ".tmp";
    writeFileSync(tmp, JSON.stringify({ tasks: [...tasks.values()] }, null, 2) + "\n");
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
    expertId:
      typeof raw.expertId === "string" && /^[\w-]{1,64}$/.test(raw.expertId)
        ? raw.expertId
        : undefined,
    enabled: raw.enabled !== false,
    lastRun: typeof raw.lastRun === "string" ? raw.lastRun : undefined,
    lastResult: ["ok", "alerted", "error"].includes(raw.lastResult) ? raw.lastResult : undefined,
    lastOutput: typeof raw.lastOutput === "string" && raw.lastOutput ? raw.lastOutput : undefined,
  };
}
