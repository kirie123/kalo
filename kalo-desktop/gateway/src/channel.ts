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
 *   /new             drop the conversation and start a fresh session
 * Anything else is a natural-language request and opens a headless session
 * through the existing `session_request` handshake (§3.3).
 *
 * Conversation state: the channel keeps the session it opened and sends
 * follow-ups INTO it (`sendPrompt`), so the assistant remembers the previous
 * turn. One run at a time — a message arriving mid-run is queued rather than
 * interleaved, because the engine has no notion of concurrent prompts.
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
  /** Optional read receipt. Carriers without reactions simply omit it. */
  addReaction?(messageId: string, emojiType: string): Promise<void>;
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
  /** Deliver a follow-up prompt into an already-running session. */
  sendPrompt: (sessionId: string, prompt: string) => void;
  /** cwd for those sessions. */
  cwd: () => string;
  now?: () => number;
}

export const CONFIRM_TTL_MS = 60_000;
const ASK_TTL_MS = 5 * 60_000;
const SESSION_ACK_TIMEOUT_MS = 120_000;
/**
 * How long one run may occupy the channel. Without this a hung engine would
 * leave `busy` stuck forever and every later message would queue silently.
 */
const RUN_TIMEOUT_MS = 15 * 60_000;
/** Feishu rejects very large text payloads; split answers well below that. */
const ANSWER_CHUNK_CHARS = 3000;
/** Bound the backlog so a burst of messages cannot grow without limit. */
const MAX_QUEUED = 5;

/** Prefix that marks a session_request as ours (scheduler owns the others). */
export const CHANNEL_TASK_PREFIX = "chat-";

export class Channel {
  private pending: Pending | null = null;
  private question: Question | null = null;
  private counter = 0;
  private awaitingSession = new Set<string>();
  private readonly now: () => number;

  // ---- conversation state -------------------------------------------------
  /** The session this conversation runs in, or null before the first turn. */
  private sessionId: string | null = null;
  /** True while a run is in flight (start requested → answer/exit). */
  private busy = false;
  /** The prompt currently being answered, kept for retry-on-dead-session. */
  private inFlight: string | null = null;
  /** Messages that arrived mid-run, delivered in order once free. */
  private queue: string[] = [];
  private runTimer: ReturnType<typeof setTimeout> | null = null;

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
   *
   * `messageId` (when the carrier supplies one) gets an immediate reaction so
   * the user knows the message landed — a run can take minutes, and silence
   * is indistinguishable from the bug where nothing was listening at all.
   */
  async handleText(raw: string, messageId?: string): Promise<void> {
    // §3.4: no transport means unpaired/disconnected — ingest nothing at all,
    // rather than queueing work whose answer could never be delivered.
    if (!this.deps.transport()) return;
    const text = normalize(raw);
    if (!text) return;

    if (messageId) void this.react(messageId, "OnIt");

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

  /** Best-effort read receipt; a carrier without reactions is fine. */
  private async react(messageId: string, emoji: string): Promise<void> {
    const t = this.deps.transport();
    if (!t?.addReaction) return;
    try {
      await t.addReaction(messageId, emoji);
    } catch (err) {
      log("channel reaction failed:", err instanceof Error ? err.message : err);
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
      case "/new": {
        // Read-only with respect to the machine: it drops our reference to
        // the session, so the next message starts a fresh one.
        const had = this.sessionId !== null || this.busy;
        this.resetConversation();
        await this.send(had ? "已开始新对话。" : "当前就是新对话。");
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

  /**
   * Route a natural-language turn.
   *
   * Three cases, in order:
   *   busy            → queue it; the engine takes one prompt at a time
   *   live session    → deliver as a follow-up, keeping the conversation
   *   no session yet  → open one via the session_request handshake
   */
  private async handleNaturalLanguage(prompt: string): Promise<void> {
    if (this.busy) {
      if (this.queue.length >= MAX_QUEUED) {
        await this.send("还在忙，消息太多了，这条没接住。等这轮结束再发吧。");
        return;
      }
      this.queue.push(prompt);
      await this.send(`收到，还在处理上一条，排在第 ${this.queue.length} 位。`);
      return;
    }

    this.busy = true;
    this.inFlight = prompt;
    this.armRunTimer();

    if (this.sessionId) {
      this.deps.sendPrompt(this.sessionId, prompt);
      return;
    }
    this.openSession(prompt);
  }

  /** Open a fresh session for `prompt` through the Rust handshake. */
  private openSession(prompt: string): void {
    this.counter += 1;
    const taskId = `${CHANNEL_TASK_PREFIX}${this.counter}`;
    this.awaitingSession.add(taskId);
    this.deps.requestSession(taskId, prompt);
    setTimeout(() => {
      if (!this.awaitingSession.delete(taskId)) return;
      this.finishRun();
      void this.send("会话没能启动（超时）。");
    }, SESSION_ACK_TIMEOUT_MS);
  }

  /**
   * A run must not hold the channel forever: if the engine hangs or dies
   * without a settled/exit event, release the slot so later messages still
   * get through.
   */
  private armRunTimer(): void {
    this.clearRunTimer();
    this.runTimer = setTimeout(() => {
      this.runTimer = null;
      if (!this.busy) return;
      log("run timed out; releasing the channel");
      this.finishRun();
      void this.send("这轮处理超时了，已经放开。可以再发一次。");
    }, RUN_TIMEOUT_MS);
  }

  private clearRunTimer(): void {
    if (this.runTimer) {
      clearTimeout(this.runTimer);
      this.runTimer = null;
    }
  }

  /** Release the run slot and start the next queued message, if any. */
  private finishRun(): void {
    this.busy = false;
    this.inFlight = null;
    this.clearRunTimer();
    const next = this.queue.shift();
    if (next !== undefined) void this.handleNaturalLanguage(next);
  }

  /** Forget the conversation; the next message opens a fresh session. */
  private resetConversation(): void {
    this.sessionId = null;
    this.busy = false;
    this.inFlight = null;
    this.queue = [];
    this.clearRunTimer();
  }

  /** Rust acknowledged our session_request. */
  handleSessionStarted(taskId: string, sessionId?: string): void {
    if (!this.awaitingSession.delete(taskId)) return;
    // Remembering the session is what makes the NEXT message a follow-up
    // instead of a brand-new engine with no memory of this one.
    if (sessionId) this.sessionId = sessionId;
  }

  /** Rust failed to spawn the session. */
  handleSessionStartFailed(taskId: string, error: string): void {
    if (!this.awaitingSession.delete(taskId)) return;
    this.finishRun();
    void this.send(`会话启动失败：${error}`);
  }

  /**
   * A follow-up could not be delivered — the session died between turns.
   * Retry once in a fresh session so the user's message survives; only the
   * conversation history is lost.
   */
  handleSessionPromptFailed(sessionId: string, error: string): void {
    if (this.sessionId !== sessionId) return;
    this.sessionId = null;
    const prompt = this.inFlight;
    if (!prompt) {
      this.finishRun();
      return;
    }
    log(`session ${sessionId} rejected a follow-up (${error}); reopening`);
    void this.send("上一个会话已失效，正在新开一个继续。");
    this.openSession(prompt);
  }

  /**
   * The run produced its final answer: deliver it in full, as its own
   * message, rather than leaving it truncated inside the progress card.
   */
  async handleAnswer(sessionId: string, answer: string): Promise<void> {
    if (this.sessionId !== sessionId) return;
    this.finishRun();
    for (const chunk of chunkText(answer, ANSWER_CHUNK_CHARS)) {
      await this.send(chunk);
    }
  }

  /** The engine process exited; the conversation cannot continue in it. */
  handleSessionExit(sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    this.sessionId = null;
    // An exit after a delivered answer is the normal end of a run.
    if (!this.busy) return;
    this.finishRun();
    void this.send("会话已结束。");
  }

  /** True when this taskId belongs to the channel rather than the scheduler. */
  owns(taskId: string): boolean {
    return taskId.startsWith(CHANNEL_TASK_PREFIX);
  }

  /** True when this sessionId is the channel's conversation. */
  ownsSession(sessionId: string): boolean {
    return this.sessionId !== null && this.sessionId === sessionId;
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

const HELP = [
  "可用命令：",
  "  /status  查看任务与计划",
  "  /stop <id|名称>  停止一个任务",
  "  /ok  确认上一个待确认操作",
  "  /new  开始新对话（清掉上下文）",
].join("\n");

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

/**
 * Split a long answer into carrier-sized pieces, preferring paragraph and
 * line boundaries so code blocks and lists survive the cut. A single line
 * longer than `max` is hard-split — nothing is ever dropped.
 */
export function chunkText(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const line of trimmed.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    // +1 for the newline we would re-introduce.
    if (current.length + line.length + 1 > max) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return chunks;
}
