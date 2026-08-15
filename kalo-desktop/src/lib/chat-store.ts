/**
 * Central chat state: current engine session, render timeline, streaming
 * flags, models/thinking level, extension UI queue, attachments and toasts.
 *
 * The store is a plain class consumed by React via useSyncExternalStore.
 * All pi-event payloads for the active session are dispatched here:
 * responses complete pending bridge promises, events mutate the timeline.
 */

import { useSyncExternalStore } from "react";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  AttachmentDraft,
  ImageContent,
  ModelInfo,
  PiEvent,
  PiEventPayload,
  PiExitInfo,
  RpcExtensionUIRequest,
  RpcResponse,
  SlashCommand,
  ThinkingLevel,
  ThinkingContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "../types";
import {
  createSession,
  closeSession,
  onPiEvent,
  onPiExit,
  onPiStderr,
  readAttachment,
  readModelsConfig,
  readSessionPage,
  rejectSessionPending,
  resolveResponse,
  sendCommand,
  sendRawCommand,
} from "./pi-bridge";

// ============================================================================
// Timeline model
// ============================================================================

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: any;
  status: "running" | "success" | "error";
  result?: any;
  partialResult?: any;
}

export interface UserEntry {
  id: string;
  kind: "user";
  message: UserMessage;
}

/** Aggregated token usage of one agent turn (summed across its LLM calls). */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AssistantEntry {
  id: string;
  kind: "assistant";
  message: AssistantMessage;
  streaming: boolean;
  /** Set at turn_end: aggregated usage of the whole turn, shown as a footer. */
  usage?: TurnUsage;
}

export interface ToolGroupEntry {
  id: string;
  kind: "toolGroup";
  toolName: string;
  calls: ToolCallRecord[];
}

export interface RetryEntry {
  id: string;
  kind: "retry";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  done?: { success: boolean; finalError?: string };
}

export interface NoticeEntry {
  id: string;
  kind: "notice";
  text: string;
}

export type TimelineEntry = UserEntry | AssistantEntry | ToolGroupEntry | RetryEntry | NoticeEntry;

// ============================================================================
// Other state slices
// ============================================================================

export interface ExtensionUiPrompt {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "warning" | "error";
}

export interface ChatState {
  sessionId: string | null;
  /** The engine-side session id (from get_state), used to highlight history items. */
  engineSessionId?: string;
  cwd: string;
  sessionName?: string;
  timeline: TimelineEntry[];
  /**
   * Paged-history window of a resumed session: `start` is the index of the
   * oldest loaded message, `hasMore` whether older messages exist on disk.
   */
  history?: { path: string; start: number; hasMore: boolean };
  loadingOlder: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  models: ModelInfo[];
  /** Models declared in ~/.kalo/agent/models.json, merged into the picker even before a session starts. */
  customModels: ModelInfo[];
  currentModel?: ModelInfo;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  steeringMode: "all" | "one-at-a-time";
  extensionQueue: ExtensionUiPrompt[];
  toasts: Toast[];
  /** Draft pushed by an extension via set_editor_text; consumed by InputBox. */
  inputDraft?: string;
  /** Pending attachments, consumed by the next sendPrompt. */
  attachments: AttachmentDraft[];
  /** Context-window usage from get_session_stats; null fields right after compaction. */
  contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
  /** On-disk session file of the live engine session, used for crash recovery. */
  sessionFile?: string;
  /** True while a resumed session's engine connects in the background (history already readable). */
  connecting?: boolean;
  /** Slash commands from get_commands (extension commands, skill:<name>, prompt templates). */
  commands: SlashCommand[];
}

const initialState: ChatState = {
  sessionId: null,
  cwd: "",
  timeline: [],
  loadingOlder: false,
  isStreaming: false,
  isCompacting: false,
  models: [],
  customModels: [],
  // Preload the last used model so the picker shows it before any session.
  currentModel: (() => {
    const s = loadLastModel();
    return s ? ({ id: s.modelId, name: s.name || s.modelId, provider: s.provider } as ModelInfo) : undefined;
  })(),
  thinkingLevel: "medium",
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  steeringMode: "one-at-a-time",
  extensionQueue: [],
  toasts: [],
  attachments: [],
  contextUsage: undefined,
  commands: [],
};

let entryCounter = 1;
const nextEntryId = () => `e-${entryCounter++}`;

let toastCounter = 1;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Last-used model persistence (survives new chats and app restarts)
// ============================================================================

const LAST_MODEL_KEY = "kalo.lastModel";
interface SavedModel {
  provider: string;
  modelId: string;
  name?: string;
}

function loadLastModel(): SavedModel | null {
  try {
    const raw = localStorage.getItem(LAST_MODEL_KEY);
    return raw ? (JSON.parse(raw) as SavedModel) : null;
  } catch {
    return null;
  }
}

function saveLastModel(m: SavedModel) {
  localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(m));
}

// ============================================================================
// Store
// ============================================================================

export class ChatStore {
  state: ChatState = initialState;

  private listeners = new Set<() => void>();
  private unlisteners: Array<() => void> = [];
  private sessionToken = 0;
  private sessionInit: Promise<string> | null = null;
  private compactionNoticeId: string | null = null;
  /** Auto-recovery attempts for the current session lifecycle (capped). */
  private recoveryCount = 0;
  /** Usage accumulator for the in-flight turn; flushed onto the last assistant entry at turn_end. */
  private turnUsage: TurnUsage | null = null;
  /** Generation guard for resumeSession: a newer resume supersedes older phases. */
  private resumeSeq = 0;
  /** In-flight background engine connect of a resume; sendPrompt awaits it. */
  private resumePromise: Promise<void> | null = null;
  // Stream batching: high-frequency deltas mutate entries in place and are
  // flushed to listeners at ~20fps, cloning only the touched entries so
  // memoized timeline items can skip re-rendering.
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingClones = new Set<string>();

  /**
   * Coalesce rapid timeline mutations into a throttled notify. The entry
   * with `entryId` gets fresh object identities down to the mutated level.
   */
  private queueTimelineFlush(entryId: string) {
    this.pendingClones.add(entryId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const ids = this.pendingClones;
      this.pendingClones = new Set();
      const t = this.state.timeline.map((e) => {
        if (!ids.has(e.id)) return e;
        if (e.kind === "assistant") return { ...e, message: { ...e.message, content: [...e.message.content] } };
        if (e.kind === "toolGroup") return { ...e, calls: [...e.calls] };
        return { ...e };
      });
      this.set({ timeline: t });
    }, 50);
  }
  /**
   * Loaded history window of a resumed session (old -> new). Kept out of
   * state so prepending pages doesn't fan out large arrays to subscribers;
   * the timeline is rebuilt from it instead.
   */
  private historyMessages: AgentMessage[] = [];
  /** Timeline entries after this index are live (post-resume), not history. */
  private historyLiveBase = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.state;

  private set(partial: Partial<ChatState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((l) => l());
  }

  private mutateTimeline(fn: (t: TimelineEntry[]) => void) {
    const t = [...this.state.timeline];
    fn(t);
    this.set({ timeline: t });
  }

  // --------------------------------------------------------------------------
  // Toasts
  // --------------------------------------------------------------------------

  pushToast(message: string, kind: Toast["kind"] = "info") {
    this.set({ toasts: [...this.state.toasts, { id: toastCounter++, message, kind }] });
  }

  dismissToast(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  private detach() {
    this.sessionToken++;
    this.unlisteners.forEach((u) => u());
    this.unlisteners = [];
  }

  /** Reset to the empty state; a fresh engine session is created lazily on first prompt. */
  newChat() {
    this.detach();
    this.clearHistory();
    this.recoveryCount = 0;
    this.turnUsage = null;
    this.resumeSeq++;
    this.set({
      sessionId: null,
      sessionName: undefined,
      timeline: [],
      history: undefined,
      loadingOlder: false,
      isStreaming: false,
      isCompacting: false,
      extensionQueue: [],
      inputDraft: undefined,
      attachments: [],
      contextUsage: undefined,
      sessionFile: undefined,
      connecting: false,
    });
  }

  private clearHistory() {
    this.historyMessages = [];
    this.historyLiveBase = 0;
  }

  private attachSession(sessionId: string, cwd: string, opts?: { keepTimeline?: boolean }) {
    this.detach();
    if (!opts?.keepTimeline) this.clearHistory();
    const token = this.sessionToken;
    this.set({
      sessionId,
      cwd,
      sessionName: undefined,
      // Two-phase resume renders history before the engine attaches; keep it.
      ...(opts?.keepTimeline ? {} : { timeline: [], history: undefined, loadingOlder: false }),
      isStreaming: false,
      isCompacting: false,
      extensionQueue: [],
      inputDraft: undefined,
      attachments: [],
      contextUsage: undefined,
      sessionFile: undefined,
    });

    const track = (p: Promise<() => void>) =>
      p.then((u) => {
        if (token === this.sessionToken) this.unlisteners.push(u);
        else u();
      });

    track(onPiEvent(sessionId, (payload) => this.handlePiPayload(payload)));
    track(
      onPiStderr(sessionId, (line) => {
        console.error("[pi stderr]", line);
      }),
    );
    track(
      onPiExit(sessionId, (info) => {
        // Stale generation: the user already moved on (new chat / switch /
        // deliberate restart), so this exit is intentional — ignore it.
        if (token !== this.sessionToken) return;
        void this.handleEngineExit(sessionId, info);
      }),
    );
  }

  /**
   * Unexpected engine exit: settle the dead generation first (pending
   * commands get an outcome, streaming entries stop spinning), then try to
   * rebuild the session from its on-disk file.
   */
  private async handleEngineExit(deadSid: string, info: PiExitInfo) {
    rejectSessionPending(deadSid, new Error("engine process exited"));
    this.finalizeStreamingEntries();
    this.set({ isStreaming: false, isCompacting: false });

    const file = this.state.sessionFile;
    if (!file || this.recoveryCount >= 2) {
      this.pushToast(
        file
          ? "引擎进程退出，自动恢复次数已用尽，请重新发起对话"
          : `引擎进程已退出（退出码 ${info.code ?? "未知"}），会话未落盘，请重新发起对话`,
        "error",
      );
      return;
    }

    this.recoveryCount++;
    this.pushToast(`引擎进程已退出（退出码 ${info.code ?? "未知"}），正在自动恢复会话…`, "warning");
    try {
      const cwd = this.state.cwd || localStorage.getItem("kalo.lastCwd") || ".";
      const sid = await this.spawnSession(cwd);
      await this.waitForEngine(sid);
      const sw = await sendCommand(sid, { type: "switch_session", sessionPath: file }, 15000);
      if (!sw.success) throw new Error(sw.error);
      await this.fetchSessionMeta(sid);
      await this.applySavedModel();
      await this.reloadLatestPage(file);
      this.pushToast("引擎已重启，会话已恢复", "info");
    } catch (err) {
      this.pushToast(`自动恢复失败：${errText(err)}，请重新发起对话`, "error");
    }
  }

  /** Stop streaming indicators on any still-streaming assistant entries. */
  private finalizeStreamingEntries() {
    const t = this.state.timeline;
    if (!t.some((e) => e.kind === "assistant" && e.streaming)) return;
    this.set({
      timeline: t.map((e) => (e.kind === "assistant" && e.streaming ? { ...e, streaming: false } : e)),
    });
  }

  /** Reload the latest page of a session file into the timeline. */
  private async reloadLatestPage(path: string) {
    const page = await readSessionPage(path, undefined, 30);
    this.historyMessages = page.messages;
    const timeline = buildTimeline(page.messages);
    this.historyLiveBase = timeline.length;
    this.set({ timeline, history: { path, start: page.start, hasMore: page.hasMore } });
  }

  /** Spawn with retry: transient failures (busy binary, AV scans) happen. */
  private async spawnSession(cwd: string, opts?: { keepTimeline?: boolean }): Promise<string> {
    let lastErr: unknown;
    for (const delay of [0, 500, 1500]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const sid = await createSession(cwd);
        this.attachSession(sid, cwd, opts);
        return sid;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Probe the engine with get_state until it answers (or the budget runs
   * out). Commands sent before the RPC dispatch loop is up are silently
   * dropped, so the probe retries with exponential backoff + jitter.
   */
  private async waitForEngine(sid: string, budgetMs = 20000) {
    const start = Date.now();
    let delay = 250;
    while (Date.now() - start < budgetMs) {
      try {
        await sendCommand(sid, { type: "get_state" }, 2000);
        return;
      } catch {
        // Not ready yet — back off and retry.
      }
      const jitter = delay * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jitter));
      delay = Math.min(delay * 2, 2000);
    }
    throw new Error("引擎无响应");
  }

  private async ensureSession(): Promise<string> {
    if (this.state.sessionId) return this.state.sessionId;
    if (this.sessionInit) return this.sessionInit;
    this.sessionInit = (async () => {
      const cwd = this.state.cwd || localStorage.getItem("kalo.lastCwd") || ".";
      const sid = await this.spawnSession(cwd);
      localStorage.setItem("kalo.lastCwd", cwd);
      await this.waitForEngine(sid);
      await this.fetchSessionMeta(sid);
      await this.applySavedModel();
      return sid;
    })().finally(() => {
      this.sessionInit = null;
    });
    return this.sessionInit;
  }

  /**
   * Restore an existing session file and render its latest page of history.
   *
   * Two phases: A renders the latest page straight from the session file
   * (instant, read-only); B then attaches the engine in the background
   * (spawn -> readiness probe -> switch_session -> meta) so the session
   * becomes continuable. The engine drops commands that arrive before its
   * RPC dispatch loop is up, hence the readiness probe before switch_session.
   */
  async resumeSession(sessionPath: string, cwd: string) {
    this.recoveryCount = 0;
    this.turnUsage = null;
    const seq = ++this.resumeSeq;

    // Phase A — render the latest page straight from the session file.
    // No engine round-trips, so history appears immediately; the session
    // stays read-only until phase B connects the engine in the background.
    this.detach();
    this.clearHistory();
    this.set({
      sessionId: null,
      cwd,
      sessionName: undefined,
      timeline: [],
      history: undefined,
      loadingOlder: false,
      isStreaming: false,
      isCompacting: false,
      extensionQueue: [],
      inputDraft: undefined,
      attachments: [],
      contextUsage: undefined,
      sessionFile: undefined,
      connecting: true,
    });
    try {
      await this.reloadLatestPage(sessionPath);
    } catch (err) {
      this.pushToast(`加载历史消息失败：${errText(err)}`, "error");
    }
    if (seq !== this.resumeSeq) return;

    // Phase B — attach the engine in the background so the session becomes
    // continuable; the timeline rendered in phase A stays untouched.
    this.resumePromise = (async () => {
      try {
        localStorage.setItem("kalo.lastCwd", cwd);
        const sid = await this.spawnSession(cwd, { keepTimeline: true });
        if (seq !== this.resumeSeq) {
          // Superseded by a newer resume/newChat: drop this engine process.
          await closeSession(sid).catch(() => {});
          return;
        }
        await this.waitForEngine(sid);
        const sw = await sendCommand(sid, { type: "switch_session", sessionPath }, 15000);
        if (!sw.success) {
          // Degrade to read-only history: the file itself is still renderable.
          this.pushToast(`会话无法续聊（${sw.error}），已切换为只读历史`, "warning");
        }
        if (seq !== this.resumeSeq) return;
        await this.fetchSessionMeta(sid);
      } catch (err) {
        if (seq === this.resumeSeq) this.pushToast(`恢复会话失败：${errText(err)}`, "error");
      } finally {
        if (seq === this.resumeSeq) this.set({ connecting: false });
        this.resumePromise = null;
      }
    })();
  }

  /** Prepend the next page of older messages to a resumed session. */
  async loadOlderHistory() {
    const h = this.state.history;
    if (!h || !h.hasMore || this.state.loadingOlder) return;
    this.set({ loadingOlder: true });
    try {
      const page = await readSessionPage(h.path, h.start, 30);
      // Session may have changed while the page was in flight.
      if (this.state.history?.path !== h.path) {
        this.set({ loadingOlder: false });
        return;
      }
      this.historyMessages = [...page.messages, ...this.historyMessages];
      // Rebuild history entries, keep live (post-resume) entries untouched.
      const live = this.state.timeline.slice(this.historyLiveBase);
      const rebuilt = buildTimeline(this.historyMessages);
      this.historyLiveBase = rebuilt.length;
      this.set({
        timeline: [...rebuilt, ...live],
        history: { ...h, start: page.start, hasMore: page.hasMore },
        loadingOlder: false,
      });
    } catch (err) {
      this.set({ loadingOlder: false });
      this.pushToast(`加载更早的消息失败：${errText(err)}`, "error");
    }
  }

  /** Pull state + model/thinking catalogs after (re)attaching a session. */
  private async fetchSessionMeta(sid: string) {
    try {
      const [stateResp, modelsResp, levelsResp, commandsResp] = await Promise.all([
        sendCommand(sid, { type: "get_state" }, 15000),
        sendCommand(sid, { type: "get_available_models" }, 15000),
        sendCommand(sid, { type: "get_available_thinking_levels" }, 15000),
        sendCommand(sid, { type: "get_commands" }, 15000),
      ]);
      const partial: Partial<ChatState> = {};
      if (stateResp.success) {
        const s = stateResp.data as import("../types").RpcSessionState;
        partial.thinkingLevel = s.thinkingLevel;
        partial.currentModel = s.model;
        partial.steeringMode = s.steeringMode;
        partial.isStreaming = s.isStreaming;
        partial.sessionName = s.sessionName;
        partial.engineSessionId = s.sessionId;
        partial.sessionFile = s.sessionFile;
      }
      if (modelsResp.success) partial.models = (modelsResp.data as { models: ModelInfo[] }).models;
      if (levelsResp.success) partial.thinkingLevels = (levelsResp.data as { levels: ThinkingLevel[] }).levels;
      if (commandsResp.success) partial.commands = (commandsResp.data as { commands: SlashCommand[] }).commands;
      this.set(partial);
      void this.refreshContextUsage();
    } catch (err) {
      this.pushToast(`获取会话状态失败：${errText(err)}`, "error");
    }
  }

  // --------------------------------------------------------------------------
  // Attachments
  // --------------------------------------------------------------------------

  /** Read each path via the backend; unreadable files are skipped with a toast. */
  async addAttachments(paths: string[]) {
    for (const path of paths) {
      try {
        const draft = await readAttachment(path);
        this.set({ attachments: [...this.state.attachments, draft] });
      } catch (err) {
        this.pushToast(`无法添加附件 ${path}：${errText(err)}`, "warning");
      }
    }
  }

  removeAttachment(name: string) {
    this.set({ attachments: this.state.attachments.filter((a) => a.name !== name) });
  }

  /** Add an image attachment directly (e.g. a clipboard paste). */
  addImageAttachment(name: string, mimeType: string, dataBase64: string) {
    this.set({
      attachments: [...this.state.attachments, { kind: "image", name, mimeType, dataBase64 }],
    });
  }

  clearAttachments() {
    if (this.state.attachments.length > 0) this.set({ attachments: [] });
  }

  // --------------------------------------------------------------------------
  // User actions
  // --------------------------------------------------------------------------

  async sendPrompt(text: string) {
    // Consume pending attachments: images ride the prompt's images field,
    // text payloads are appended as labeled blocks.
    const attachments = this.state.attachments;
    const images: ImageContent[] = [];
    let message = text.trim();
    for (const a of attachments) {
      if (a.kind === "image") {
        images.push({ type: "image", data: a.dataBase64, mimeType: a.mimeType });
      } else {
        message += `\n\n【附件：${a.name}】\n${a.text}${a.truncated ? "\n…（内容已截断）" : ""}`;
      }
    }
    if (!message && images.length === 0) return;
    // A resumed session may still be connecting its engine in the background.
    if (this.resumePromise) await this.resumePromise;
    try {
      const sid = await this.ensureSession();
      const resp = await sendCommand(sid, {
        type: "prompt",
        message,
        images: images.length > 0 ? images : undefined,
        streamingBehavior: this.state.isStreaming ? "steer" : undefined,
      });
      this.clearAttachments();
      if (!resp.success) this.pushToast(`发送失败：${resp.error}`, "error");
    } catch (err) {
      this.pushToast(`发送失败：${errText(err)}`, "error");
    }
  }

  private contextInflight = false;

  /** Refresh context-window usage from the engine (get_session_stats). */
  async refreshContextUsage() {
    const sid = this.state.sessionId;
    if (!sid || this.contextInflight) return;
    this.contextInflight = true;
    try {
      const resp = await sendCommand(sid, { type: "get_session_stats" }, 15000);
      if (resp.success) {
        const usage = (resp.data as { contextUsage?: ChatState["contextUsage"] } | undefined)?.contextUsage;
        if (usage !== undefined) this.set({ contextUsage: usage });
      }
    } catch {
      // Stats are best-effort UI decoration.
    } finally {
      this.contextInflight = false;
    }
  }

  /** Manually compact the conversation context (engine `compact` command). */
  async compact() {
    const sid = this.state.sessionId;
    if (!sid) {
      this.pushToast("请先开始一段对话", "info");
      return;
    }
    if (this.state.isCompacting) return;
    try {
      const resp = await sendCommand(sid, { type: "compact" });
      if (!resp.success) this.pushToast(`上下文压缩失败：${resp.error}`, "error");
    } catch (err) {
      this.pushToast(`上下文压缩失败：${errText(err)}`, "error");
    }
  }

  async abort() {
    const sid = this.state.sessionId;
    if (!sid) return;
    try {
      await sendCommand(sid, { type: "abort" });
    } catch (err) {
      this.pushToast(`停止失败：${errText(err)}`, "error");
    }
  }

  /**
   * Change the working directory. With an empty session the engine process
   * is restarted in place; mid-conversation the new cwd applies to the next
   * new chat; without a session it is only remembered.
   */
  async setCwd(cwd: string) {
    this.set({ cwd });
    localStorage.setItem("kalo.lastCwd", cwd);
    if (!this.state.sessionId) return;
    if (this.state.timeline.length === 0) {
      try {
        await this.restartSession();
      } catch (err) {
        this.pushToast(`切换工作目录失败：${errText(err)}`, "error");
      }
    } else {
      this.pushToast("新工作目录将在下次新对话时生效", "info");
    }
  }

  /**
   * Load custom providers from ~/.kalo/agent/models.json into the picker.
   * These are shown even before a session exists; the engine itself picks
   * them up when a (new) session process spawns.
   */
  async loadCustomModels() {
    try {
      const cfg = await readModelsConfig();
      const custom: ModelInfo[] = [];
      for (const [providerId, p] of Object.entries(cfg.providers ?? {})) {
        for (const m of p.models ?? []) {
          custom.push({
            id: m.id,
            name: m.name || m.id,
            provider: providerId,
            api: p.api,
            baseUrl: p.baseUrl,
          });
        }
      }
      this.set({ customModels: custom });
    } catch {
      // Config unreadable — keep the picker engine-driven only.
    }
  }

  async setModel(provider: string, modelId: string) {
    const friendlyError = (raw: string): string => {
      if (/^Model not found/i.test(raw)) {
        return "引擎未识别该模型。若刚添加 Provider，请编辑保存一次（本地服务需任意占位 API Key）后重试";
      }
      if (/^No API key/i.test(raw)) {
        return "该 Provider 未配置 API Key。本地服务（Ollama 等）请在设置中编辑并填入任意占位 Key";
      }
      return raw;
    };
    try {
      const sid = await this.ensureSession();
      const resp = await sendCommand(sid, { type: "set_model", provider, modelId }, 15000);
      if (resp.success) {
        this.set({ currentModel: resp.data as ModelInfo });
        saveLastModel({ provider, modelId, name: (resp.data as ModelInfo)?.name });
        return;
      }
      // The running engine reads models.json at spawn, so a provider added
      // after this session started is unknown to it. If nothing has been
      // said yet, silently restart the session and retry once.
      const isCustom = this.state.customModels.some(
        (m) => m.provider === provider && m.id === modelId,
      );
      if (isCustom && this.state.timeline.length === 0) {
        await this.restartSession();
        const sid2 = this.state.sessionId;
        if (!sid2) throw new Error("session restart failed");
        const retry = await sendCommand(sid2, { type: "set_model", provider, modelId }, 15000);
        if (retry.success) {
          this.set({ currentModel: retry.data as ModelInfo });
          saveLastModel({ provider, modelId, name: (retry.data as ModelInfo)?.name });
          return;
        }
        this.pushToast(`切换模型失败：${friendlyError(retry.error)}`, "error");
        return;
      }
      this.pushToast(`切换模型失败：${friendlyError(resp.error)}`, "error");
    } catch (err) {
      this.pushToast(`切换模型失败：${errText(err)}`, "error");
    }
  }

  /** Re-apply the last used model to a freshly spawned engine (best-effort). */
  private async applySavedModel() {
    const saved = loadLastModel();
    const sid = this.state.sessionId;
    if (!saved || !sid) return;
    const cur = this.state.currentModel;
    if (cur?.provider === saved.provider && cur?.id === saved.modelId) return;
    try {
      const resp = await sendCommand(sid, { type: "set_model", provider: saved.provider, modelId: saved.modelId }, 15000);
      if (resp.success) this.set({ currentModel: resp.data as ModelInfo });
    } catch {
      // Saved model no longer available — keep the engine default.
    }
  }

  /** Close the current engine process and spawn a fresh one in the same cwd. */
  private async restartSession() {
    const oldSid = this.state.sessionId;
    const cwd = this.state.cwd || localStorage.getItem("kalo.lastCwd") || ".";
    if (oldSid) {
      try {
        await closeSession(oldSid);
      } catch {
        // Already gone — fine.
      }
    }
    this.detach();
    const sid = await this.spawnSession(cwd);
    await this.waitForEngine(sid);
    await this.fetchSessionMeta(sid);
    await this.applySavedModel();
  }

  async cycleThinkingLevel() {
    const sid = this.state.sessionId;
    if (!sid) {
      this.pushToast("请先开始一段对话", "info");
      return;
    }
    const resp = await sendCommand(sid, { type: "cycle_thinking_level" });
    if (resp.success) {
      const level = (resp.data as { level: ThinkingLevel } | null)?.level;
      if (level) this.set({ thinkingLevel: level });
    } else {
      this.pushToast(`切换思考等级失败：${resp.error}`, "error");
    }
  }

  async setSteeringMode(mode: "all" | "one-at-a-time") {
    const sid = this.state.sessionId;
    if (!sid) {
      // No engine yet: remember locally, applied implicitly on next session.
      this.set({ steeringMode: mode });
      return;
    }
    const resp = await sendCommand(sid, { type: "set_steering_mode", mode });
    if (resp.success) this.set({ steeringMode: mode });
    else this.pushToast(`设置权限模式失败：${resp.error}`, "error");
  }

  clearInputDraft() {
    this.set({ inputDraft: undefined });
  }

  /** Answer the current extension UI prompt and pop it from the queue. */
  async respondExtension(id: string, answer: { value: string } | { confirmed: boolean } | { cancelled: true }) {
    const sid = this.state.sessionId;
    this.set({ extensionQueue: this.state.extensionQueue.filter((q) => q.id !== id) });
    if (!sid) return;
    try {
      await sendRawCommand(sid, { type: "extension_ui_response", id, ...answer });
    } catch (err) {
      this.pushToast(`回复扩展请求失败：${errText(err)}`, "error");
    }
  }

  // --------------------------------------------------------------------------
  // Event dispatch
  // --------------------------------------------------------------------------

  private handlePiPayload(payload: PiEventPayload) {
    if (!payload || typeof payload !== "object") return;
    const type = (payload as { type?: string }).type;

    if (type === "response") {
      resolveResponse(payload as RpcResponse);
      return;
    }
    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(payload as RpcExtensionUIRequest);
      return;
    }
    this.handleAgentEvent(payload as PiEvent);
  }

  private handleExtensionUiRequest(req: RpcExtensionUIRequest) {
    switch (req.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor": {
        const prompt: ExtensionUiPrompt = {
          id: req.id,
          method: req.method,
          title: req.title,
          message: req.method === "confirm" ? req.message : undefined,
          options: req.method === "select" ? req.options : undefined,
          placeholder: req.method === "input" ? req.placeholder : undefined,
          prefill: req.method === "editor" ? req.prefill : undefined,
        };
        this.set({ extensionQueue: [...this.state.extensionQueue, prompt] });
        break;
      }
      case "notify":
        this.pushToast(req.message, req.notifyType ?? "info");
        break;
      case "setTitle":
        document.title = req.title || "Kalo";
        break;
      case "set_editor_text":
        this.set({ inputDraft: req.text });
        break;
      case "setStatus":
      case "setWidget":
        // Status lines and widgets are not rendered yet.
        break;
    }
  }

  private handleAgentEvent(ev: PiEvent) {
    switch (ev.type) {
      case "agent_start":
        this.set({ isStreaming: true });
        break;
      case "agent_end":
        if (!ev.willRetry) this.set({ isStreaming: false });
        void this.refreshContextUsage();
        break;
      case "agent_settled":
        this.set({ isStreaming: false, isCompacting: false });
        break;

      case "message_start":
        this.onMessageStart(ev.message);
        break;
      case "message_update":
        this.applyAssistantEvent(ev.assistantMessageEvent);
        break;
      case "message_end":
        this.onMessageEnd(ev.message);
        break;

      case "tool_execution_start":
        this.onToolStart(ev.toolCallId, ev.toolName, ev.args);
        break;
      case "tool_execution_update":
        this.applyToolPartial(ev.toolCallId, ev.partialResult);
        break;
      case "tool_execution_end":
        this.updateToolRecord(ev.toolCallId, (rec) => ({
          ...rec,
          status: ev.isError ? "error" : "success",
          result: ev.result,
        }));
        break;

      case "compaction_start":
        this.compactionNoticeId = nextEntryId();
        this.set({ isCompacting: true });
        this.mutateTimeline((t) => t.push({ id: this.compactionNoticeId!, kind: "notice", text: "正在压缩上下文…" }));
        break;
      case "compaction_end": {
        const text = ev.aborted
          ? "上下文压缩已取消"
          : ev.errorMessage
            ? `上下文压缩失败：${ev.errorMessage}`
            : "上下文已压缩";
        this.set({ isCompacting: false });
        void this.refreshContextUsage();
        this.mutateTimeline((t) => {
          const idx = t.findIndex((e) => e.id === this.compactionNoticeId);
          if (idx >= 0) t[idx] = { ...t[idx], text } as NoticeEntry;
          else t.push({ id: nextEntryId(), kind: "notice", text });
        });
        break;
      }

      case "auto_retry_start":
        this.mutateTimeline((t) =>
          t.push({
            id: nextEntryId(),
            kind: "retry",
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            errorMessage: ev.errorMessage,
          }),
        );
        break;
      case "auto_retry_end":
        this.mutateTimeline((t) => {
          for (let i = t.length - 1; i >= 0; i--) {
            const e = t[i];
            if (e.kind === "retry" && !e.done) {
              t[i] = { ...e, done: { success: ev.success, finalError: ev.finalError } };
              return;
            }
          }
        });
        break;

      case "thinking_level_changed":
        this.set({ thinkingLevel: ev.level });
        break;
      case "session_info_changed":
        this.set({ sessionName: ev.name });
        break;
      case "extension_error":
        this.pushToast(`扩展错误：${ev.error ?? "未知错误"}`, "error");
        break;

      case "turn_end":
        this.attachTurnUsage();
        break;

      default:
        // turn_start/queue_update/bash_execution_update/... need no UI
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Message lifecycle
  // --------------------------------------------------------------------------

  private onMessageStart(message: AgentMessage) {
    if (message.role === "user") {
      this.mutateTimeline((t) => t.push({ id: nextEntryId(), kind: "user", message }));
    } else if (message.role === "assistant") {
      this.mutateTimeline((t) =>
        t.push({ id: nextEntryId(), kind: "assistant", message: { ...message, content: [] }, streaming: true }),
      );
    }
    // toolResult starts are ignored; results arrive via tool_execution_end / message_end
  }

  private onMessageEnd(message: AgentMessage) {
    if (message.role === "assistant") {
      // Accumulate token usage for the running turn (flushed at turn_end).
      const u = message.usage;
      if (u) {
        this.turnUsage = {
          input: (this.turnUsage?.input ?? 0) + (u.input ?? 0),
          output: (this.turnUsage?.output ?? 0) + (u.output ?? 0),
          cacheRead: (this.turnUsage?.cacheRead ?? 0) + (u.cacheRead ?? 0),
          cacheWrite: (this.turnUsage?.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
        };
      }
      // Replace the streaming partial with the authoritative message.
      this.mutateTimeline((t) => {
        for (let i = t.length - 1; i >= 0; i--) {
          const e = t[i];
          if (e.kind === "assistant" && e.streaming) {
            t[i] = { ...e, message, streaming: false };
            return;
          }
        }
        t.push({ id: nextEntryId(), kind: "assistant", message, streaming: false });
      });
    } else if (message.role === "toolResult") {
      // Fallback: fill a tool record that never saw tool_execution_end
      // (e.g. result replayed from a session reload mid-stream).
      const tr = message as ToolResultMessage;
      this.updateToolRecord(tr.toolCallId, (rec) =>
        rec.status === "running"
          ? { ...rec, status: tr.isError ? "error" : "success", result: { content: tr.content, details: tr.details, isError: tr.isError } }
          : rec,
      );
    }
  }

  /** Attach the accumulated turn usage to the last assistant entry (turn footer). */
  private attachTurnUsage() {
    if (!this.turnUsage) return;
    const usage = this.turnUsage;
    this.turnUsage = null;
    this.mutateTimeline((t) => {
      for (let i = t.length - 1; i >= 0; i--) {
        const e = t[i];
        if (e.kind === "assistant") {
          t[i] = { ...e, usage };
          return;
        }
      }
    });
  }

  /**
   * Incremental assembly of the streaming assistant message, keyed on
   * contentIndex: *_start inserts a block, *_delta appends, *_end finalizes.
   *
   * Deltas mutate the entry in place and notify via the throttled flush;
   * discrete lifecycle frames (seed/done/error/start) render immediately.
   */
  private applyAssistantEvent(ev: AssistantMessageEvent) {
    // Discrete frames keep the immediate path.
    if (ev.type === "done" || ev.type === "error" || ev.type === "start") {
      this.mutateTimeline((t) => {
        const idx = this.findStreamingAssistant(t);
        if (idx === -1) return;
        const entry = t[idx] as AssistantEntry;
        if (ev.type === "done") t[idx] = { ...entry, message: ev.message };
        else if (ev.type === "error") t[idx] = { ...entry, message: ev.error };
        else t[idx] = { ...entry, message: { ...entry.message, content: [] } };
      });
      return;
    }

    const t = this.state.timeline;
    const idx = this.findStreamingAssistant(t);
    if (idx === -1) {
      // No message_start seen; seed from the partial carried by the event.
      const partial = "partial" in ev ? (ev.partial as AssistantMessage) : "message" in ev ? (ev as { message: AssistantMessage }).message : undefined;
      if (partial) {
        this.mutateTimeline((tl) =>
          tl.push({ id: nextEntryId(), kind: "assistant", message: { ...partial, content: [...partial.content] }, streaming: true }),
        );
      }
      return;
    }

    const entry = t[idx] as AssistantEntry;
    const content = entry.message.content as any[];
    const i = ev.contentIndex;
    switch (ev.type) {
      case "text_start":
        content[i] = { type: "text", text: "" };
        break;
      case "text_delta": {
        const b = content[i];
        if (b?.type === "text") b.text += ev.delta;
        break;
      }
      case "text_end":
        content[i] = { type: "text", text: ev.content };
        break;
      case "thinking_start":
        content[i] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta": {
        const b = content[i];
        if (b?.type === "thinking") b.thinking += ev.delta;
        break;
      }
      case "thinking_end":
        // _done marks the block finished so its spinner stops even while
        // later blocks of the same message are still streaming.
        content[i] = { type: "thinking", thinking: ev.content, _done: true };
        break;
      case "toolcall_start":
        content[i] = { type: "toolCall", id: "", name: "", arguments: {}, _rawArgs: "" };
        break;
      case "toolcall_delta": {
        const b = content[i];
        if (b?.type === "toolCall") b._rawArgs = (b._rawArgs ?? "") + ev.delta;
        break;
      }
      case "toolcall_end":
        content[i] = ev.toolCall as ToolCallContent;
        break;
    }
    this.queueTimelineFlush(entry.id);
  }

  private findStreamingAssistant(t: TimelineEntry[]): number {
    for (let i = t.length - 1; i >= 0; i--) {
      const e = t[i];
      if (e.kind === "assistant" && e.streaming) return i;
    }
    return -1;
  }

  // --------------------------------------------------------------------------
  // Tool execution aggregation
  // --------------------------------------------------------------------------

  private onToolStart(toolCallId: string, toolName: string, args: any) {
    const rec: ToolCallRecord = { toolCallId, toolName, args, status: "running" };
    this.mutateTimeline((t) => {
      const last = t[t.length - 1];
      // Consecutive calls of the same tool collapse into one group.
      if (last?.kind === "toolGroup" && last.toolName === toolName) {
        t[t.length - 1] = { ...last, calls: [...last.calls, rec] };
      } else {
        t.push({ id: nextEntryId(), kind: "toolGroup", toolName, calls: [rec] });
      }
    });
  }

  /** High-frequency tool progress: mutate in place, flush throttled. */
  private applyToolPartial(toolCallId: string, partialResult: any) {
    const t = this.state.timeline;
    for (let gi = t.length - 1; gi >= 0; gi--) {
      const e = t[gi];
      if (e.kind !== "toolGroup") continue;
      const rec = e.calls.find((c) => c.toolCallId === toolCallId);
      if (!rec) continue;
      rec.partialResult = partialResult;
      this.queueTimelineFlush(e.id);
      return;
    }
  }

  private updateToolRecord(toolCallId: string, fn: (rec: ToolCallRecord) => ToolCallRecord) {
    this.mutateTimeline((t) => {
      for (let gi = t.length - 1; gi >= 0; gi--) {
        const e = t[gi];
        if (e.kind !== "toolGroup") continue;
        const ci = e.calls.findIndex((c) => c.toolCallId === toolCallId);
        if (ci === -1) continue;
        const calls = [...e.calls];
        calls[ci] = fn(calls[ci]);
        t[gi] = { ...e, calls };
        return;
      }
    });
  }
}

// ============================================================================
// History reconstruction (get_messages -> timeline)
// ============================================================================

function buildTimeline(messages: AgentMessage[]): TimelineEntry[] {
  const t: TimelineEntry[] = [];
  const pendingCalls = new Map<string, ToolCallRecord>();

  const addCall = (rec: ToolCallRecord) => {
    const last = t[t.length - 1];
    if (last?.kind === "toolGroup" && last.toolName === rec.toolName) {
      last.calls.push(rec);
    } else {
      t.push({ id: nextEntryId(), kind: "toolGroup", toolName: rec.toolName, calls: [rec] });
    }
  };

  for (const m of messages) {
    if (m.role === "user") {
      t.push({ id: nextEntryId(), kind: "user", message: m });
    } else if (m.role === "assistant") {
      t.push({ id: nextEntryId(), kind: "assistant", message: m, streaming: false });
      for (const c of m.content) {
        if (c.type === "toolCall") {
          const rec: ToolCallRecord = {
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            status: "running",
          };
          pendingCalls.set(c.id, rec);
          addCall(rec);
        }
      }
    } else if (m.role === "toolResult") {
      const result = { content: m.content, details: m.details, isError: m.isError };
      const rec = pendingCalls.get(m.toolCallId);
      if (rec) {
        rec.status = m.isError ? "error" : "success";
        rec.result = result;
        pendingCalls.delete(m.toolCallId);
      } else {
        addCall({
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          args: {},
          status: m.isError ? "error" : "success",
          result,
        });
      }
    }
  }

  // Calls without a recorded result (aborted run): mark as errored so the
  // UI doesn't show an eternal spinner.
  for (const rec of pendingCalls.values()) {
    rec.status = "error";
  }
  return t;
}

// ============================================================================
// Singleton + React hook
// ============================================================================

export const chatStore = new ChatStore();

export function useChatStore(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
}
