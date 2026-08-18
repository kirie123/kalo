/**
 * Channel (P0-2) — one way in and out, independent of its carrier.
 *
 * The carrier (today: Feishu) only strips @mentions and formatting and hands
 * up plain text; ALL parsing, confirmation and routing lives here, so a second
 * carrier costs a transport adapter and nothing else.
 *
 * Grammar (§3.2), deliberately tiny:
 *   /status          job snapshot + scheduler state (read-only, no confirm)
 *   /stop <id|name>  stop a job — mutating, so it needs /ok
 *   /ok              second gate of the double confirm
 * Anything else is a natural-language request and opens a headless session
 * through the existing `session_request` handshake (§3.3).
 *
 * Security (§3.4): the carrier admits the bound open_id only; mutating
 * operations always land in a pending slot first; /ok applies to the most
 * recent pending item and expires after 60s; after unbind there is no
 * transport, so nothing is ingested.
 */

import { log } from "./protocol";
import type { ScheduleTaskInfo } from "./scheduler";
import type { JobSnapshot } from "./jobs/types";

/** Everything the channel needs from a carrier. */
export interface ChannelTransport {
  sendText(text: string): Promise<string>;
  updateText(messageId: string, text: string): Promise<void>;
}

/** A mutating operation held back until the user answers /ok. */
interface Pending {
  describe: string;
  run: () => string;
  expiresAt: number;
}

/** An outstanding ask(): the next inbound line answers it. */
interface Question {
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChannelDeps {
  /** Live transport, or null while unpaired/disconnected. */
  transport: () => ChannelTransport | null;
  /** Job reads/writes go through the same registry the model uses. */
  listJobs: () => JobSnapshot[];
  killJob: (id: string, reason?: string) => string;
  listSchedules: () => ScheduleTaskInfo[];
  /** Open a headless session for a natural-language request. */
  requestSession: (taskId: string, prompt: string) => void;
  /** cwd for those sessions. */
  cwd: () => string;
  now?: () => number;
}

export const CONFIRM_TTL_MS = 60_000;
const ASK_TTL_MS = 5 * 60_000;
const SESSION_ACK_TIMEOUT_MS = 120_000;

/** Prefix that marks a session_request as ours (scheduler owns the others). */
export const CHANNEL_TASK_PREFIX = "chat-";

export class Channel {
  private pending: Pending | null = null;
  private question: Question | null = null;
  private counter = 0;
  private awaitingSession = new Set<string>();
  private readonly now: () => number;

  constructor(private deps: ChannelDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------------ out

  /** Push one message; resolves to the carrier's message id. */
  async send(text: string): Promise<string | null> {
    const t = this.deps.transport();
    if (!t) {
      log("channel send dropped: no transport");
      return null;
    }
    try {
      return await t.sendText(text);
    } catch (err) {
      log("channel send failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Edit a message in place (progress scrolling). */
  async updateText(messageId: string, text: string): Promise<void> {
    const t = this.deps.transport();
    if (!t) return;
    try {
      await t.updateText(messageId, text);
    } catch (err) {
      log("channel update failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Ask a question and wait for the next inbound line (or time out). */
  ask(text: string, opts?: { choices?: string[]; timeoutMs?: number }): Promise<string | null> {
    // Only one question outstanding at a time; a new ask abandons the old one.
    const stale = this.question;
    this.question = null;
    stale?.resolve("");

    const body = opts?.choices?.length ? `${text}\n${opts.choices.map((c) => `· ${c}`).join("\n")}` : text;
    void this.send(body);

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.question?.timer === timer) this.question = null;
        resolve(null);
      }, opts?.timeoutMs ?? ASK_TTL_MS);
      this.question = {
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        timer,
      };
    });
  }

  // ------------------------------------------------------------------- in

  /**
   * Handle one inbound line. The carrier has already checked the sender.
   * Never throws: a bad line is answered, not propagated.
   */
  async handleText(raw: string): Promise<void> {
    // §3.4: no transport means unpaired/disconnected — ingest nothing at all,
    // rather than queueing work whose answer could never be delivered.
    if (!this.deps.transport()) return;
    const text = normalize(raw);
    if (!text) return;

    // An outstanding ask() consumes the line before any parsing.
    const q = this.question;
    if (q) {
      this.question = null;
      q.resolve(text);
      return;
    }

    this.expirePending();

    try {
      if (text.startsWith("/")) {
        await this.handleCommand(text);
        return;
      }
      await this.handleNaturalLanguage(text);
    } catch (err) {
      await this.send(`出错了：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCommand(text: string): Promise<void> {
    const [head, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (head.toLowerCase()) {
      case "/status":
        await this.send(this.renderStatus());
        return;
      case "/stop": {
        if (!arg) {
          await this.send("用法：/stop <任务 id 或名称>");
          return;
        }
        await this.propose(arg);
        return;
      }
      case "/ok": {
        const p = this.pending;
        this.pending = null;
        if (!p) {
          await this.send("没有待确认的操作。");
          return;
        }
        await this.send(p.run());
        return;
      }
      case "/help":
        await this.send(HELP);
        return;
      default:
        await this.send(`未知命令：${head}\n${HELP}`);
    }
  }

  /** Queue a stop behind /ok rather than executing it. */
  private async propose(arg: string): Promise<void> {
    const job = this.resolveJob(arg);
    if (!job) {
      await this.send(`没有找到运行中的任务：${arg}`);
      return;
    }
    this.pending = {
      describe: `停止 ${job.id} ${job.label}`,
      expiresAt: this.now() + CONFIRM_TTL_MS,
      run: () => {
        const result = this.deps.killJob(job.id, "来自消息通道的停止请求");
        return result === "already-finished" ? `[${job.id}] 已经结束了。` : `[${job.id}] 已请求停止。`;
      },
    };
    await this.send(`确认要停止 [${job.id}] ${job.label} 吗？回 /ok 执行（60 秒内有效）。`);
  }

  /** Exact id first, then a unique label match among live jobs. */
  private resolveJob(arg: string): JobSnapshot | null {
    const jobs = this.deps.listJobs();
    const byId = jobs.find((j) => j.id === arg);
    if (byId) return byId;
    const live = jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "stopping");
    const hits = live.filter((j) => j.label === arg);
    return hits.length === 1 ? hits[0] : null;
  }

  private async handleNaturalLanguage(prompt: string): Promise<void> {
    this.counter += 1;
    const taskId = `${CHANNEL_TASK_PREFIX}${this.counter}`;
    this.awaitingSession.add(taskId);
    this.deps.requestSession(taskId, prompt);
    setTimeout(() => {
      if (!this.awaitingSession.delete(taskId)) return;
      void this.send("会话没能启动（超时）。");
    }, SESSION_ACK_TIMEOUT_MS);
  }

  /** Rust acknowledged our session_request. */
  handleSessionStarted(taskId: string): void {
    this.awaitingSession.delete(taskId);
  }

  /** Rust failed to spawn the session. */
  handleSessionStartFailed(taskId: string, error: string): void {
    if (!this.awaitingSession.delete(taskId)) return;
    void this.send(`会话启动失败：${error}`);
  }

  /** True when this taskId belongs to the channel rather than the scheduler. */
  owns(taskId: string): boolean {
    return taskId.startsWith(CHANNEL_TASK_PREFIX);
  }

  // -------------------------------------------------------------- render

  private renderStatus(): string {
    const jobs = this.deps.listJobs();
    const tasks = this.deps.listSchedules();
    const lines: string[] = [];

    lines.push("任务：");
    if (!jobs.length) lines.push("  （无）");
    for (const j of jobs) {
      const detail = j.detail ? ` — ${j.detail}` : "";
      lines.push(`  [${j.id}] ${j.label} · ${STATUS_TEXT[j.status] ?? j.status}${detail}`);
    }

    lines.push("", "计划：");
    if (!tasks.length) lines.push("  （无）");
    for (const t of tasks) {
      const next = t.nextRunAt ? ` · 下次 ${t.nextRunAt}` : "";
      lines.push(`  [${t.id}] ${t.name} · ${t.enabled ? t.kind : "已停用"}${next}`);
    }
    return lines.join("\n");
  }

  private expirePending(): void {
    if (this.pending && this.pending.expiresAt <= this.now()) this.pending = null;
  }

  /** Test/introspection hook: the operation currently awaiting /ok. */
  pendingDescription(): string | null {
    this.expirePending();
    return this.pending?.describe ?? null;
  }
}

const HELP = ["可用命令：", "  /status  查看任务与计划", "  /stop <id|名称>  停止一个任务", "  /ok  确认上一个待确认操作"].join(
  "\n",
);

const STATUS_TEXT: Record<string, string> = {
  queued: "等待门控",
  running: "运行中",
  stopping: "停止中",
  completed: "已完成",
  killed: "已停止",
  failed: "失败",
};

/** Strip carrier decoration (@mentions, zero-width marks, stray whitespace). */
export function normalize(raw: string): string {
  const ZERO_WIDTH = /[​-‏﻿]/g;
  return raw
    .replace(/@_user_\d+/g, " ")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim();
}
