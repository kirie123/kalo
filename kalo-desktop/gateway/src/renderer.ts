/**
 * Engine event → Feishu progress message renderer (P0 read-only).
 *
 * Mapping (doc/kalo-desktop-im-gateway-plan.md §5.1):
 *   agent_start          → create one progress message per run
 *   tool_execution_*     → append "· <什么事> <对象>" lines (throttled)
 *   message_update       → latest complete sentence of the streaming text
 *   auto_retry_start     → "⚠️ 正在重试"
 *   compaction_start     → "🗜️ 正在压缩上下文"
 *   agent_settled        → final "✅ 完成" + reaction
 *   errors / session_exit→ final "❌ 失败" + reaction
 *
 * This card is glanced at on a phone while a run is in flight, so it answers
 * "what is it doing now" in the reader's language — not "which function was
 * invoked with which flags". Tool names are mapped to plain descriptions,
 * arguments are reduced to a host/basename, repeated steps collapse to "x3",
 * and the running commentary is one finished sentence rather than a raw
 * sliding window. Nothing is lost by this: the complete answer is delivered
 * as its own message through onAnswer.
 *
 * All updates target the SAME message (im.v1.message.update) and pass a
 * per-session throttle (≥1.2s) plus a global spacing (≥300ms) to respect
 * Feishu rate limits. Out-of-order writes are prevented by chaining every
 * session's API call after the previous one settles.
 */

import { basename } from "node:path";
import type { FeishuConnection } from "./feishu";
import { log } from "./protocol";

const SESSION_MIN_UPDATE_MS = 1200;
const GLOBAL_MIN_UPDATE_MS = 300;
const MAX_TOOL_LINES = 6;
const TAIL_CHARS = 300;
/** The progress card shows one short sentence, not a 300-char raw window. */
const NOTE_CHARS = 120;
const MAX_BODY_CHARS = 3500;
const FLUSH_TICK_MS = 500;

/**
 * Tool name → what it actually does, in the reader's language.
 *
 * The card is read on a phone by someone who wants to know "what is it doing
 * now", not "which function was invoked". Unknown tools fall back to their
 * raw name, so a new tool degrades to the old behaviour instead of vanishing.
 */
const TOOL_LABELS: Record<string, string> = {
  bash: "执行命令",
  read: "读取文件",
  write: "写入文件",
  edit: "修改文件",
  ls: "列目录",
  find: "查找文件",
  glob: "查找文件",
  grep: "搜索内容",
  web_fetch: "抓取网页",
  web_search: "搜索网页",
  use_skill: "加载技能",
  todo_write: "更新计划",
  job_list: "查看后台任务",
  job_output: "读取任务输出",
  job_kill: "停止任务",
};

export interface RendererDeps {
  /**
   * The run produced a final answer. The progress card is a *card* — capped
   * at TAIL_CHARS and overwritten in place — so the answer is delivered
   * separately, in full, rather than being left truncated inside it.
   * `answer` is the complete final assistant text.
   */
  onAnswer?: (sessionId: string, answer: string) => void;
}

type SessionState = "creating" | "running" | "done" | "error";

interface SessionProgress {
  project: string;
  messageId?: string;
  state: SessionState;
  startedAt: number;
  turns: number;
  toolLines: string[];
  tail: string;
  lastUserText?: string;
  finalNote?: string;
  /** Full final assistant text (untruncated), captured at agent_end. */
  answer?: string;
  /** Set when the create/update call failed hard (e.g. message deleted). */
  broken?: boolean;
  dirty: boolean;
  lastFlushAt: number;
  lastSentBody?: string;
  /** Serializes this session's API calls (prevents out-of-order updates). */
  chain: Promise<void>;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function firstLine(text: string, max = 60): string {
  const idx = text.indexOf("\n");
  return truncate(idx >= 0 ? text.slice(0, idx) : text, max);
}

/**
 * Human-readable one-liner for a tool call's arguments.
 *
 * Optimised for "what is it touching", not for reproducing the call:
 *   - URLs collapse to their host (the query string is noise on a phone)
 *   - shell commands keep the leading program plus its first real argument,
 *     dropping pipelines and flag soup
 *   - paths keep the basename, since the directory is usually the project
 * Anything unrecognised falls back to a short first-line excerpt.
 */
function summarizeArgs(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";

  const url = typeof args.url === "string" ? args.url : "";
  if (url) return hostOf(url);

  if (typeof args.query === "string" && args.query) return firstLine(args.query, 40);

  // use_skill / todo_write carry a name rather than a target.
  if (toolName === "use_skill" && typeof args.name === "string") return args.name;

  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  if (command) return summarizeCommand(command);

  const path = args.path ?? args.file_path ?? args.filePath;
  if (typeof path === "string" && path) return basename(path) || path;

  if (typeof args.pattern === "string" && args.pattern) return firstLine(args.pattern, 40);

  return "";
}

/** `https://api.coingecko.com/api/v3/...?ids=...` → `api.coingecko.com` */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return firstLine(url, 40);
  }
}

/**
 * Reduce a shell command to "program + what it acts on".
 * `curl -s --max-time 15 "https://api.binance.com/..."` → `curl api.binance.com`
 *
 * A URL anywhere in the command wins, because that IS the subject. Otherwise
 * take the first bare argument that is not a flag's value — `--max-time 15`
 * must not be mistaken for the target. If everything is flags, the program
 * name alone is still a useful line.
 */
function summarizeCommand(command: string): string {
  // Tokenize BEFORE cutting at the pipeline: `python -c "a; b"` must not be
  // split on the semicolon inside the quotes.
  const raw = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const stop = raw.findIndex((t) => /^(\||;|&&?|\|\|)$/.test(t));
  const tokens = (stop >= 0 ? raw.slice(0, stop) : raw).map((t) =>
    t.replace(/^["']|["']$/g, ""),
  );
  if (!tokens.length) return firstLine(command, 40);

  const program = basename(tokens[0]) || tokens[0];
  const say = (target: string) => truncate(target ? `${program} ${target}` : program, 44);

  const url = tokens.find((t) => /^https?:\/\//i.test(t));
  if (url) return say(hostOf(url));

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.startsWith("-")) continue;
    if (tokens[i - 1].startsWith("-")) continue; // this is the flag's value
    return say(basename(token) || token);
  }
  return say("");
}

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/**
 * Pick the last COMPLETE sentence from the streaming tail.
 *
 * `tail` is a fixed-size sliding window, so it usually starts mid-word and
 * ends mid-word. Rendering it verbatim produced the run-on wall of text this
 * exists to fix. Taking the last finished sentence gives a line that starts
 * and ends somewhere meaningful; if nothing has finished yet, fall back to
 * the trailing fragment so the card is not blank early in a run.
 */
export function latestSentence(tail: string, max: number): string {
  const clean = tail.replace(/\s+/g, " ").trim();
  if (!clean) return "";

  // Split after CJK and ASCII sentence enders, keeping the punctuation.
  const parts = clean.split(/(?<=[。！？；!?;])\s*/).filter((p) => p.trim());
  if (!parts.length) return truncate(clean, max);

  const lastComplete = [...parts].reverse().find((p) => /[。！？；!?;]$/.test(p.trim()));
  // Prefer a finished sentence; otherwise the in-progress fragment, which at
  // least begins right after the previous sentence ended.
  const picked = lastComplete ?? parts[parts.length - 1];
  const text = picked.trim();
  // A very long "sentence" (no punctuation for ages) still needs a cap, and
  // its tail is the freshest part.
  if (text.length > max) return "…" + text.slice(-(max - 1));
  return text;
}

export class ProgressRenderer {
  private sessions = new Map<string, SessionProgress>();
  private timer: ReturnType<typeof setInterval>;
  private lastGlobalUpdate = 0;

  constructor(private feishu: FeishuConnection, private deps: RendererDeps = {}) {
    this.timer = setInterval(() => this.flushDue(), FLUSH_TICK_MS);
  }

  handleEvent(sessionId: string, cwd: string, payload: any): void {
    if (!payload || typeof payload.type !== "string") return;
    let sp = this.sessions.get(sessionId);
    const isNewRun = !sp || sp.state === "done" || sp.state === "error";
    if (isNewRun && payload.type !== "agent_start") {
      // Events before agent_start (or after a finished run) still update
      // state when a session record exists; otherwise they are ignored.
      if (!sp) return;
      if (sp.state === "done" || sp.state === "error") return;
    }

    switch (payload.type) {
      case "agent_start": {
        if (isNewRun) {
          sp = this.createSession(sessionId, cwd);
          this.sessions.set(sessionId, sp);
        } else if (sp) {
          // Continuing run (e.g. follow-up prompt) — reset transient fields.
          sp.state = "running";
          sp.toolLines = [];
          sp.tail = "";
          sp.finalNote = undefined;
          sp.answer = undefined;
          sp.dirty = true;
        }
        break;
      }
      case "message_start":
      case "message_end": {
        const message = payload.message;
        if (message?.role === "user") {
          const text = textOfContent(message.content);
          if (text) sp!.lastUserText = truncate(text, 100);
        }
        break;
      }
      case "message_update": {
        const ev = payload.assistantMessageEvent;
        if (ev?.type === "text_delta" && typeof ev.delta === "string") {
          sp!.tail = (sp!.tail + ev.delta).slice(-TAIL_CHARS);
          sp!.dirty = true;
        }
        break;
      }
      case "turn_end": {
        sp!.turns += 1;
        break;
      }
      case "tool_execution_start": {
        const label = TOOL_LABELS[payload.toolName] ?? payload.toolName;
        const detail = summarizeArgs(payload.toolName, payload.args);
        this.pushLine(sp!, detail ? `· ${label} ${detail}` : `· ${label}`);
        break;
      }
      case "tool_execution_end": {
        if (payload.isError) {
          const label = TOOL_LABELS[payload.toolName] ?? payload.toolName;
          this.pushLine(sp!, `· ${label} 失败`);
        }
        break;
      }
      case "auto_retry_start": {
        this.pushLine(
          sp!,
          `⚠️ 自动重试 第${payload.attempt}/${payload.maxAttempts}次：${firstLine(String(payload.errorMessage ?? ""), 60)}`,
        );
        break;
      }
      case "compaction_start": {
        this.pushLine(sp!, "🗜️ 正在压缩上下文");
        break;
      }
      case "agent_end": {
        // Capture the final assistant text as the run summary.
        const messages: any[] = Array.isArray(payload.messages) ? payload.messages : [];
        const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
        const text = lastAssistant ? textOfContent(lastAssistant.content) : "";
        if (text) {
          sp!.tail = text.slice(-TAIL_CHARS);
          // Keep the FULL text too: the card shows a tail, the answer message
          // shows everything. A retry overwrites this with the later attempt.
          sp!.answer = text;
          sp!.dirty = true;
        }
        if (payload.willRetry) this.pushLine(sp!, "⚠️ 本轮出错，即将重试");
        break;
      }
      case "agent_settled": {
        this.finalize(sp!, "done", `✅ 完成（用时 ${formatDuration(Date.now() - sp!.startedAt)} · 轮次 ${sp!.turns}）`);
        const answer = sp!.answer?.trim();
        if (answer) {
          try {
            this.deps.onAnswer?.(sessionId, answer);
          } catch (err) {
            log("onAnswer handler failed:", err instanceof Error ? err.message : err);
          }
        }
        break;
      }
      case "extension_error": {
        this.pushLine(sp!, `⚠️ ${firstLine(String(payload.error ?? "扩展错误"), 80)}`);
        break;
      }
      default:
        break;
    }
  }

  handleExit(sessionId: string, code: number | null): void {
    const sp = this.sessions.get(sessionId);
    if (!sp || sp.state === "done" || sp.state === "error") return;
    if (code === 0 || code === null) {
      this.finalize(sp, "done", `⏹ 会话已结束（用时 ${formatDuration(Date.now() - sp.startedAt)}）`);
    } else {
      this.finalize(sp, "error", `❌ 引擎进程异常退出（code ${code}）`);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.sessions.clear();
  }

  // ------------------------------------------------------------------ //

  private createSession(sessionId: string, cwd: string): SessionProgress {
    const now = Date.now();
    return {
      project: basename(cwd) || cwd || "会话",
      state: "creating",
      startedAt: now,
      turns: 0,
      toolLines: [],
      tail: "",
      dirty: true,
      lastFlushAt: 0,
      chain: Promise.resolve(),
    };
  }

  private pushLine(sp: SessionProgress, line: string): void {
    // Collapse a repeated step ("抓取网页 x3") instead of stacking identical
    // rows: three consecutive web_fetch lines say nothing three times.
    const prev = sp.toolLines[sp.toolLines.length - 1];
    if (prev !== undefined) {
      const base = prev.replace(/ x\d+$/, "");
      if (base === line) {
        const count = Number(prev.match(/ x(\d+)$/)?.[1] ?? 1) + 1;
        sp.toolLines[sp.toolLines.length - 1] = `${base} x${count}`;
        sp.dirty = true;
        return;
      }
    }
    sp.toolLines.push(line);
    if (sp.toolLines.length > MAX_TOOL_LINES) {
      sp.toolLines.splice(0, sp.toolLines.length - MAX_TOOL_LINES);
      if (!sp.toolLines[0].startsWith("…")) sp.toolLines.unshift("…");
    }
    sp.dirty = true;
  }

  private finalize(sp: SessionProgress, state: "done" | "error", note: string): void {
    sp.state = state;
    sp.finalNote = note;
    sp.dirty = true;
    // Final states flush through the regular pipeline but skip the
    // session-interval gate (they are terminal, one-shot).
    this.enqueue(sp, { bypassInterval: true, reaction: state === "done" ? "DONE" : "CrossMark" });
  }

  private renderBody(sp: SessionProgress): string {
    const lines: string[] = [`[${sp.project}]`];
    if (sp.state === "creating" || sp.state === "running") {
      lines.push("🔄 处理中…");
    } else {
      lines.push(sp.finalNote ?? "已结束");
    }
    if (sp.lastUserText) lines.push(`💬 ${sp.lastUserText}`);
    if (sp.toolLines.length) lines.push("", ...sp.toolLines);
    // While running, show only the latest complete sentence rather than a raw
    // 300-char window: the window starts mid-word and, with newlines collapsed
    // to spaces, reads as several turns of thinking mashed together. The full
    // text is not lost — it goes out as its own message via onAnswer.
    if (sp.state === "creating" || sp.state === "running") {
      const note = latestSentence(sp.tail, NOTE_CHARS);
      if (note) lines.push("", `📝 ${note}`);
    }
    let body = lines.join("\n");
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS - 1) + "…";
    return body;
  }

  /** Periodic flush: sessions whose interval elapsed and body changed. */
  private flushDue(): void {
    const now = Date.now();
    for (const sp of this.sessions.values()) {
      if (!sp.dirty || sp.broken) continue;
      if (sp.state === "done" || sp.state === "error") continue; // flushed eagerly
      if (!sp.messageId && sp.state !== "creating") continue;
      if (now - sp.lastFlushAt < SESSION_MIN_UPDATE_MS) continue;
      if (now - this.lastGlobalUpdate < GLOBAL_MIN_UPDATE_MS) continue;
      this.enqueue(sp, {});
    }
  }

  /**
   * Serialize one API action per session. `bypassInterval` is used for
   * terminal states; creating a missing message takes priority over updates.
   */
  private enqueue(
    sp: SessionProgress,
    opts: { bypassInterval?: boolean; reaction?: string } = {},
  ): void {
    sp.dirty = false;
    sp.lastFlushAt = Date.now();
    this.lastGlobalUpdate = Date.now();
    const needCreate = !sp.messageId;

    sp.chain = sp.chain
      .then(async () => {
        if (needCreate) {
          const body = this.renderBody(sp);
          const messageId = await this.feishu.sendText(body);
          sp.messageId = messageId;
          sp.lastSentBody = body;
          sp.state = sp.state === "creating" ? "running" : sp.state;
          if (opts.reaction) await this.feishu.addReaction(messageId, opts.reaction);
          return;
        }
        const body = this.renderBody(sp);
        if (body === sp.lastSentBody) {
          if (opts.reaction) await this.feishu.addReaction(sp.messageId!, opts.reaction);
          return;
        }
        await this.feishu.updateText(sp.messageId!, body);
        sp.lastSentBody = body;
        if (opts.reaction) await this.feishu.addReaction(sp.messageId!, opts.reaction);
      })
      .catch((err) => {
        sp.dirty = true; // retry on the next flush
        log(
          `session update failed (state=${sp.state}):`,
          err instanceof Error ? err.message : err,
        );
      });
  }
}
