/**
 * Central chat state — engine-pool edition.
 *
 * The store manages a pool of SessionRuntime instances, one per engine
 * session (keyed by normalized session file, or `fresh-N` before the first
 * message is persisted). Switching sessions merely changes which runtime's
 * view feeds the UI; parked runtimes keep their engine process alive, so
 * background runs continue and their events keep updating the parked view.
 * Idle parked engines beyond MAX_PARKED are evicted (LRU); streaming or
 * connecting ones never are.
 *
 * The store is a plain class consumed by React via useSyncExternalStore.
 * The exposed ChatState is a composition: global slice (model catalogs,
 * toasts) + the active runtime's session view + pool-visible flags
 * (runningByFile drives the sidebar spinners).
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
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
  RpcSessionState,
  SlashCommand,
  ThinkingLevel,
  ThinkingContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "../types";
import {
  accumulate,
  createAccumulator,
  summarize,
  type ChangeAccumulator,
  type ChangeSummary,
} from "./changed-files";
import {
  createSession,
  closeSession,
  onPiEvent,
  onPiExit,
  onPiStderr,
  readAttachment,
  readAttachmentBytes,
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

/** Aggregated token usage of one agent run (summed across all its LLM calls/turns). */
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
  /** Set at agent_settled: aggregated usage of the whole run, shown once as a footer. */
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

/**
 * End-of-run summary of the files the agent wrote or edited. Pushed once at
 * `agent_settled`, and only when at least one file changed.
 */
export interface ChangesEntry extends ChangeSummary {
  id: string;
  kind: "changes";
}

export type TimelineEntry = UserEntry | AssistantEntry | ToolGroupEntry | RetryEntry | NoticeEntry | ChangesEntry;

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
  /** Engine-pool: which session files (normalized paths) have a run in flight. */
  runningByFile: Record<string, boolean>;
}

/**
 * Session-scoped slice of ChatState. Every pooled session owns one of these;
 * the store exposes the active session's view merged over the global slice so
 * components keep reading a flat ChatState. currentModel/thinkingLevel/
 * steeringMode live here because each engine process keeps its own values.
 */
type SessionView = Pick<
  ChatState,
  | "sessionId"
  | "engineSessionId"
  | "cwd"
  | "sessionName"
  | "timeline"
  | "history"
  | "loadingOlder"
  | "isStreaming"
  | "isCompacting"
  | "currentModel"
  | "thinkingLevel"
  | "steeringMode"
  | "extensionQueue"
  | "inputDraft"
  | "attachments"
  | "contextUsage"
  | "sessionFile"
  | "connecting"
>;

/** Engine-process-global catalogs + app-level bits shared by all runtimes. */
type GlobalView = Pick<ChatState, "models" | "customModels" | "thinkingLevels" | "toasts" | "commands">;

const SESSION_VIEW_KEYS = new Set<keyof SessionView>([
  "sessionId",
  "engineSessionId",
  "cwd",
  "sessionName",
  "timeline",
  "history",
  "loadingOlder",
  "isStreaming",
  "isCompacting",
  "currentModel",
  "thinkingLevel",
  "steeringMode",
  "extensionQueue",
  "inputDraft",
  "attachments",
  "contextUsage",
  "sessionFile",
  "connecting",
]);

/** Normalize a path for pool keys / file matching (Windows-safe). */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Same-keys-same-values check for the runningByFile flag maps. */
function sameFlags(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Session-view changes that alter pool-visible flags (runningByFile) must commit. */
function affectsPoolFlags(p: Partial<SessionView>): boolean {
  return "isStreaming" in p || "connecting" in p || "sessionFile" in p;
}

/** Session-scoped fields reset for every fresh runtime. */
function freshView(cwd = ""): SessionView {
  const saved = loadLastModel();
  return {
    sessionId: null,
    cwd,
    timeline: [],
    loadingOlder: false,
    isStreaming: false,
    isCompacting: false,
    currentModel: saved ? ({ id: saved.modelId, name: saved.name || saved.modelId, provider: saved.provider } as ModelInfo) : undefined,
    thinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    extensionQueue: [],
    attachments: [],
    contextUsage: undefined,
  };
}

/**
 * One pooled engine session: the view state above plus everything needed to
 * keep it alive in the background (event routing, history window, recovery).
 * Switching sessions never tears a runtime down — only pool eviction,
 * deliberate restart, or app exit kills its engine process.
 */
class SessionRuntime {
  /**
   * Pool key: normalized session file path once known, else `fresh-N`.
   * Re-keyed by the store when the engine reports its session file.
   */
  key: string;
  view: SessionView;
  /** Tauri event unlisteners for this runtime's engine process. */
  unlisteners: Array<() => void> = [];
  /** Generation guard: bumps on restart/teardown so stale callbacks no-op. */
  token = 0;
  /** Engine exited before any message was persisted — nothing to recover from. */
  dead = false;
  historyMessages: AgentMessage[] = [];
  /** Timeline entries after this index are live (post-resume), not history. */
  historyLiveBase = 0;
  /** Usage accumulator for the in-flight run (agent_start → agent_settled). */
  runUsage: TurnUsage | null = null;
  /** Files written/edited during the in-flight run, folded per path. */
  runChanges: ChangeAccumulator = createAccumulator();
  /** Auto-recovery attempts for this runtime's lifecycle (capped). */
  recoveryCount = 0;
  /** In-flight lazy engine connect (new chat) of this runtime. */
  sessionInit: Promise<string> | null = null;
  /** Background engine connect of a resume; sendPrompt awaits it. */
  resumePromise: Promise<void> | null = null;
  compactionNoticeId: string | null = null;
  lastActive = Date.now();
  // Per-runtime stream batching (20fps clone flush).
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  pendingClones = new Set<string>();

  constructor(key: string, cwd = "") {
    this.key = key;
    this.view = freshView(cwd);
  }
}

/** Cap on parked (non-active) idle engines; streaming ones are never evicted. */
const MAX_PARKED = 4;

const initialGlobal: GlobalView = {
  models: [],
  customModels: [],
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  toasts: [],
  commands: [],
};

let entryCounter = 1;
const nextEntryId = () => `e-${entryCounter++}`;

let toastCounter = 1;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Base64 payload of a File, without the `data:...;base64,` prefix. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

let pastedImageCounter = 1;

/** A raw clipboard bitmap (a screenshot) arrives as a nameless `image.png`;
 *  label those, and keep real file names as-is. */
function pastedImageName(file: File): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1] || "png";
  return `粘贴图片-${pastedImageCounter++}.${ext}`;
}

/** Attachment names are the chip key and the removal key, so they must be
 *  distinct: a collision gets `(2)`, `(3)`, … before the extension. */
function uniqueAttachmentName(name: string, existing: AttachmentDraft[]): string {
  const taken = new Set(existing.map((a) => a.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
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
  /** Composed snapshot: global slice + active session view + pool flags. */
  private _state!: ChatState;
  private global: GlobalView = { ...initialGlobal };

  /** Engine pool. Keyed by normalized session file, or `fresh-N` per new chat. */
  private runtimes = new Map<string, SessionRuntime>();
  /** Counter for `fresh-N` keys (a fresh chat may never touch a file). */
  private freshSeq = 0;
  /** The runtime whose view feeds the UI. */
  private active: SessionRuntime;

  private listeners = new Set<() => void>();
  private contextInflight = false;

  constructor() {
    this.active = new SessionRuntime(`fresh-${this.freshSeq++}`);
    this.runtimes.set(this.active.key, this.active);
    this.commit();
  }

  get state(): ChatState {
    return this._state;
  }

  /** The active runtime (shorthand for event/mutation call sites). */
  private get rt(): SessionRuntime {
    return this.active;
  }

  /**
   * Coalesce rapid timeline mutations into a throttled notify. The entry
   * with `entryId` gets fresh object identities down to the mutated level.
   */
  private queueTimelineFlush(entryId: string, rt: SessionRuntime = this.active) {
    rt.pendingClones.add(entryId);
    if (rt.flushTimer) return;
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      const ids = rt.pendingClones;
      rt.pendingClones = new Set<string>();
      const t = rt.view.timeline.map((e) => {
        if (!ids.has(e.id)) return e;
        if (e.kind === "assistant") return { ...e, message: { ...e.message, content: [...e.message.content] } };
        if (e.kind === "toolGroup") return { ...e, calls: [...e.calls] };
        return { ...e };
      });
      this.setRt(rt, { timeline: t });
    }, 50);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this._state;

  /**
   * Rebuild the composed snapshot and notify listeners. runningByFile is
   * recomputed here so background streaming flips sidebar spinners even
   * though the parked runtime's view is not rendered. Its object identity is
   * kept stable while the flags are unchanged, so field-level subscribers
   * (useChatSelector) are not woken by every commit.
   */
  private commit() {
    const runningByFile: Record<string, boolean> = {};
    for (const rt of this.runtimes.values()) {
      const f = rt.view.sessionFile;
      if (f && (rt.view.isStreaming || rt.view.connecting)) runningByFile[normPath(f)] = rt.view.isStreaming;
    }
    const prev = this._state?.runningByFile;
    const stable = prev && sameFlags(prev, runningByFile) ? prev : runningByFile;
    this._state = { ...this.global, ...this.active.view, runningByFile: stable };
    this.listeners.forEach((l) => l());
  }

  /**
   * Write a partial update. Session-scoped keys land on the active runtime's
   * view; global keys on the shared slice; then commit.
   */
  private set(partial: Partial<ChatState>) {
    for (const [k, v] of Object.entries(partial)) {
      if (SESSION_VIEW_KEYS.has(k as keyof SessionView)) {
        (this.active.view as Record<string, unknown>)[k] = v;
      } else {
        (this.global as Record<string, unknown>)[k] = v;
      }
    }
    this.commit();
  }

  /** Write session-scoped keys onto any (possibly parked) runtime. */
  private setRt(rt: SessionRuntime, partial: Partial<SessionView>) {
    Object.assign(rt.view, partial);
    // Parked updates only re-render when pool-visible flags change.
    if (rt === this.active || affectsPoolFlags(partial)) this.commit();
  }

  private mutateTimeline(fn: (t: TimelineEntry[]) => void, rt: SessionRuntime = this.active) {
    const t = [...rt.view.timeline];
    fn(t);
    this.setRt(rt, { timeline: t });
  }

  // --------------------------------------------------------------------------
  // Toasts
  // --------------------------------------------------------------------------

  pushToast(message: string, kind: Toast["kind"] = "info") {
    this.set({ toasts: [...this.global.toasts, { id: toastCounter++, message, kind }] });
  }

  dismissToast(id: number) {
    this.set({ toasts: this.global.toasts.filter((t) => t.id !== id) });
  }

  // --------------------------------------------------------------------------
  // Session lifecycle (engine pool)
  // --------------------------------------------------------------------------

  private detachRt(rt: SessionRuntime) {
    rt.token++;
    rt.unlisteners.forEach((u) => u());
    rt.unlisteners = [];
  }

  /** Kill a pooled runtime's engine and drop it from the pool. */
  private async killRt(rt: SessionRuntime) {
    rt.dead = true;
    this.detachRt(rt);
    const sid = rt.view.sessionId;
    this.runtimes.delete(rt.key);
    if (sid) await closeSession(sid).catch(() => {});
    this.commit();
  }

  /** Evict idle parked engines beyond MAX_PARKED; streaming ones are never evicted. */
  private evictIdle() {
    const parked = [...this.runtimes.values()].filter(
      (rt) => rt !== this.active && !rt.view.isStreaming && !rt.view.connecting,
    );
    if (parked.length <= MAX_PARKED) return;
    parked.sort((a, b) => a.lastActive - b.lastActive);
    for (const rt of parked.slice(0, parked.length - MAX_PARKED)) {
      void this.killRt(rt);
    }
  }

  /**
   * Park the current runtime and switch to a fresh view. The parked engine
   * keeps running (mid-run tasks continue; events keep updating its view).
   */
  newChat() {
    this.active.lastActive = Date.now();
    const cwd = this.active.view.cwd || localStorage.getItem("kalo.lastCwd") || "";
    const rt = new SessionRuntime(`fresh-${this.freshSeq++}`, cwd);
    this.runtimes.set(rt.key, rt);
    this.active = rt;
    this.commit();
    this.evictIdle();
  }

  /**
   * Kill the engine bound to a session file (called when its history is
   * deleted). If it is the active view, switch to a fresh chat first.
   */
  async closeSessionFile(path: string) {
    const rt = this.runtimes.get(normPath(path));
    if (!rt) return;
    if (rt === this.active) this.newChat();
    await this.killRt(rt);
  }

  private attachSession(rt: SessionRuntime, sessionId: string, cwd: string, opts?: { keepTimeline?: boolean }) {
    this.detachRt(rt);
    if (!opts?.keepTimeline) {
      rt.historyMessages = [];
      rt.historyLiveBase = 0;
    }
    rt.token++;
    const token = rt.token;
    this.setRt(rt, {
      sessionId,
      cwd,
      sessionName: undefined,
      engineSessionId: undefined,
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
        if (token === rt.token) rt.unlisteners.push(u);
        else u();
      });

    track(onPiEvent(sessionId, (payload) => this.handlePiPayload(payload, rt)));
    track(
      onPiStderr(sessionId, (line) => {
        if (rt === this.active) console.error("[pi stderr]", line);
      }),
    );
    track(
      onPiExit(sessionId, (info) => {
        // Deliberate teardown or a newer engine for this runtime: intentional.
        if (rt.dead || token !== rt.token) return;
        void this.handleEngineExit(rt, sessionId, info);
      }),
    );
  }

  /**
   * Unexpected engine exit: settle the dead generation first (pending
   * commands get an outcome, streaming entries stop spinning), then try to
   * rebuild the session from its on-disk file. Works for parked runtimes
   * too — the recovered engine keeps feeding the parked view.
   */
  private async handleEngineExit(rt: SessionRuntime, deadSid: string, info: PiExitInfo) {
    rejectSessionPending(deadSid, new Error("engine process exited"));
    this.finalizeStreamingEntries(rt);
    this.setRt(rt, { isStreaming: false, isCompacting: false, sessionId: null });

    const isActive = rt === this.active;
    const file = rt.view.sessionFile;
    if (!file || rt.recoveryCount >= 2) {
      if (isActive) {
        this.pushToast(
          file
            ? "引擎进程退出，自动恢复次数已用尽，请重新发起对话"
            : `引擎进程已退出（退出码 ${info.code ?? "未知"}），会话未落盘，请重新发起对话`,
          "error",
        );
      }
      return;
    }

    rt.recoveryCount++;
    if (isActive) this.pushToast(`引擎进程已退出（退出码 ${info.code ?? "未知"}），正在自动恢复会话…`, "warning");
    try {
      const cwd = rt.view.cwd || localStorage.getItem("kalo.lastCwd") || ".";
      const sid = await this.spawnSession(rt, cwd, { keepTimeline: true });
      await this.waitForEngine(sid);
      const sw = await sendCommand(sid, { type: "switch_session", sessionPath: file }, 15000);
      if (!sw.success) throw new Error(sw.error);
      await this.fetchSessionMeta(rt, sid);
      await this.reloadLatestPage(rt, file);
      if (isActive) this.pushToast("引擎已重启，会话已恢复", "info");
    } catch (err) {
      if (isActive) this.pushToast(`自动恢复失败：${errText(err)}，请重新发起对话`, "error");
    }
  }

  /** Stop streaming indicators on any still-streaming assistant entries. */
  private finalizeStreamingEntries(rt: SessionRuntime) {
    const t = rt.view.timeline;
    if (!t.some((e) => e.kind === "assistant" && e.streaming)) return;
    this.setRt(rt, {
      timeline: t.map((e) => (e.kind === "assistant" && e.streaming ? { ...e, streaming: false } : e)),
    });
  }

  /** Reload the latest page of a session file into the runtime's timeline. */
  private async reloadLatestPage(rt: SessionRuntime, path: string) {
    const page = await readSessionPage(path, undefined, 30);
    rt.historyMessages = page.messages;
    const timeline = buildTimeline(page.messages);
    rt.historyLiveBase = timeline.length;
    this.setRt(rt, { timeline, history: { path, start: page.start, hasMore: page.hasMore } });
  }

  /** Spawn with retry: transient failures (busy binary, AV scans) happen. */
  private async spawnSession(rt: SessionRuntime, cwd: string, opts?: { keepTimeline?: boolean }): Promise<string> {
    let lastErr: unknown;
    for (const delay of [0, 500, 1500]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const sid = await createSession(cwd);
        this.attachSession(rt, sid, cwd, opts);
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
   *
   * The per-probe timeout grows with the backoff instead of sitting at the
   * full budget: a dropped first probe used to cost a flat 2s before the
   * second one was even sent, which is most of the perceived startup lag.
   */
  private async waitForEngine(sid: string, budgetMs = 20000) {
    const start = Date.now();
    let delay = 250;
    let probeTimeout = 300;
    while (Date.now() - start < budgetMs) {
      try {
        await sendCommand(sid, { type: "get_state" }, probeTimeout);
        return;
      } catch {
        // Not ready yet — back off and retry.
      }
      const jitter = delay * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jitter));
      delay = Math.min(delay * 2, 2000);
      probeTimeout = Math.min(probeTimeout * 2, 2000);
    }
    throw new Error("引擎无响应");
  }

  private ensureSession(rt: SessionRuntime = this.active): Promise<string> {
    if (rt.view.sessionId) return Promise.resolve(rt.view.sessionId);
    if (rt.sessionInit) return rt.sessionInit;
    rt.sessionInit = (async () => {
      const cwd = rt.view.cwd || localStorage.getItem("kalo.lastCwd") || ".";
      const sid = await this.spawnSession(rt, cwd);
      localStorage.setItem("kalo.lastCwd", cwd);
      await this.waitForEngine(sid);
      await this.fetchSessionMeta(rt, sid);
      await this.applySavedModel(rt);
      return sid;
    })().finally(() => {
      rt.sessionInit = null;
    });
    return rt.sessionInit;
  }

  /**
   * Restore an existing session file and render its latest page of history.
   *
   * Pool hit: the session's runtime (and its engine) already exists — just
   * switch the active view; a run in flight keeps going untouched.
   *
   * Pool miss: create a runtime keyed by the file. Phase A renders the
   * latest page straight from the session file (instant, read-only); phase
   * B attaches the engine in the background (spawn -> readiness probe ->
   * switch_session -> meta) so the session becomes continuable.
   */
  async resumeSession(sessionPath: string, cwd: string) {
    const key = normPath(sessionPath);

    const existing = this.runtimes.get(key);
    if (existing) {
      existing.lastActive = Date.now();
      if (existing === this.active) return;
      this.active = existing;
      this.commit();
      this.evictIdle();
      return;
    }

    const rt = new SessionRuntime(key, cwd);
    this.runtimes.set(key, rt);
    this.active = rt;
    this.commit();
    this.evictIdle();

    // Phase A — render the latest page straight from the session file.
    // No engine round-trips, so history appears immediately; the session
    // stays read-only until phase B connects the engine in the background.
    this.setRt(rt, { connecting: true });
    try {
      await this.reloadLatestPage(rt, sessionPath);
    } catch (err) {
      this.pushToast(`加载历史消息失败：${errText(err)}`, "error");
    }

    // Phase B — attach the engine in the background so the session becomes
    // continuable; the timeline rendered in phase A stays untouched.
    rt.resumePromise = (async () => {
      try {
        localStorage.setItem("kalo.lastCwd", cwd);
        const sid = await this.spawnSession(rt, cwd, { keepTimeline: true });
        await this.waitForEngine(sid);
        const sw = await sendCommand(sid, { type: "switch_session", sessionPath }, 15000);
        if (!sw.success) {
          // Degrade to read-only history: the file itself is still renderable.
          if (rt === this.active) this.pushToast(`会话无法续聊（${sw.error}），已切换为只读历史`, "warning");
        }
        await this.fetchSessionMeta(rt, sid);
      } catch (err) {
        if (rt === this.active) this.pushToast(`恢复会话失败：${errText(err)}`, "error");
      } finally {
        rt.resumePromise = null;
        this.setRt(rt, { connecting: false });
      }
    })();
  }

  /** Prepend the next page of older messages to the active session. */
  async loadOlderHistory() {
    const rt = this.rt;
    const h = rt.view.history;
    if (!h || !h.hasMore || rt.view.loadingOlder) return;
    this.setRt(rt, { loadingOlder: true });
    try {
      const page = await readSessionPage(h.path, h.start, 30);
      // Session may have changed while the page was in flight.
      if (rt.view.history?.path !== h.path) {
        this.setRt(rt, { loadingOlder: false });
        return;
      }
      rt.historyMessages = [...page.messages, ...rt.historyMessages];
      // Rebuild history entries, keep live (post-resume) entries untouched.
      const live = rt.view.timeline.slice(rt.historyLiveBase);
      const rebuilt = buildTimeline(rt.historyMessages);
      rt.historyLiveBase = rebuilt.length;
      this.setRt(rt, {
        timeline: [...rebuilt, ...live],
        history: { ...h, start: page.start, hasMore: page.hasMore },
        loadingOlder: false,
      });
    } catch (err) {
      this.setRt(rt, { loadingOlder: false });
      this.pushToast(`加载更早的消息失败：${errText(err)}`, "error");
    }
  }

  /**
   * Pull state + model/thinking catalogs after (re)attaching a session.
   * Session fields land on the runtime's own view (works while parked);
   * catalogs are shared and only refreshed by the active runtime's engine.
   * A `fresh-N` runtime is re-keyed to its session file once known.
   */
  private async fetchSessionMeta(rt: SessionRuntime, sid: string) {
    try {
      const [stateResp, modelsResp, levelsResp, commandsResp] = await Promise.all([
        sendCommand(sid, { type: "get_state" }, 15000),
        sendCommand(sid, { type: "get_available_models" }, 15000),
        sendCommand(sid, { type: "get_available_thinking_levels" }, 15000),
        sendCommand(sid, { type: "get_commands" }, 15000),
      ]);
      const sessionPartial: Partial<SessionView> = {};
      if (stateResp.success) {
        const s = stateResp.data as RpcSessionState;
        sessionPartial.thinkingLevel = s.thinkingLevel;
        sessionPartial.currentModel = s.model;
        sessionPartial.steeringMode = s.steeringMode;
        sessionPartial.isStreaming = s.isStreaming;
        sessionPartial.sessionName = s.sessionName;
        sessionPartial.engineSessionId = s.sessionId;
        sessionPartial.sessionFile = s.sessionFile;
      }
      if (rt === this.active) {
        if (modelsResp.success) this.global.models = (modelsResp.data as { models: ModelInfo[] }).models;
        if (levelsResp.success) this.global.thinkingLevels = (levelsResp.data as { levels: ThinkingLevel[] }).levels;
        if (commandsResp.success) this.global.commands = (commandsResp.data as { commands: SlashCommand[] }).commands;
      }
      this.setRt(rt, sessionPartial);
      this.rekeyRuntime(rt);
      this.commit();
      void this.refreshContextUsage(rt);
    } catch (err) {
      if (rt === this.active) this.pushToast(`获取会话状态失败：${errText(err)}`, "error");
    }
  }

  /** Move a `fresh-N` runtime onto its session-file key once the file exists. */
  private rekeyRuntime(rt: SessionRuntime) {
    const f = rt.view.sessionFile;
    if (!f || !rt.key.startsWith("fresh-")) return;
    const nk = normPath(f);
    if (nk === rt.key || this.runtimes.has(nk)) return;
    this.runtimes.delete(rt.key);
    rt.key = nk;
    this.runtimes.set(nk, rt);
  }

  /** Best-effort get_state probe to pick up the session file after a prompt. */
  private async syncSessionFile(rt: SessionRuntime) {
    const sid = rt.view.sessionId;
    if (!sid) return;
    try {
      const resp = await sendCommand(sid, { type: "get_state" }, 15000);
      if (!resp.success) return;
      const s = resp.data as RpcSessionState;
      if (!s.sessionFile) return;
      this.setRt(rt, { sessionFile: s.sessionFile, engineSessionId: s.sessionId });
      this.rekeyRuntime(rt);
      this.commit();
    } catch {
      // Best-effort only.
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
        this.pushAttachment(draft);
      } catch (err) {
        this.pushToast(`无法添加附件 ${path}：${errText(err)}`, "warning");
      }
    }
  }

  /**
   * Add attachments from webview File objects (clipboard paste). These carry
   * bytes but no path, so images are kept in memory and everything else is
   * handed to the backend extractor as base64.
   */
  async addFiles(files: File[]) {
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file);
        if (file.type.startsWith("image/")) {
          this.pushAttachment({
            kind: "image",
            name: pastedImageName(file),
            mimeType: file.type,
            dataBase64: base64,
          });
        } else {
          this.pushAttachment(await readAttachmentBytes(file.name, base64));
        }
      } catch (err) {
        this.pushToast(`无法添加附件 ${file.name}：${errText(err)}`, "warning");
      }
    }
  }

  removeAttachment(name: string) {
    this.set({ attachments: this.rt.view.attachments.filter((a) => a.name !== name) });
  }

  /** Append one draft, renaming on collision — `name` is the chip's identity. */
  private pushAttachment(draft: AttachmentDraft) {
    const existing = this.rt.view.attachments;
    const name = uniqueAttachmentName(draft.name, existing);
    this.set({ attachments: [...existing, name === draft.name ? draft : { ...draft, name }] });
  }

  clearAttachments() {
    if (this.rt.view.attachments.length > 0) this.set({ attachments: [] });
  }

  // --------------------------------------------------------------------------
  // User actions (always target the active runtime)
  // --------------------------------------------------------------------------

  async sendPrompt(text: string) {
    const rt = this.rt;
    // Consume pending attachments: images ride the prompt's images field,
    // text payloads are appended as labeled blocks.
    const attachments = rt.view.attachments;
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
    if (rt.resumePromise) await rt.resumePromise;
    try {
      const sid = await this.ensureSession(rt);
      const resp = await sendCommand(sid, {
        type: "prompt",
        message,
        images: images.length > 0 ? images : undefined,
        streamingBehavior: rt.view.isStreaming ? "steer" : undefined,
      });
      this.clearAttachments();
      if (!resp.success) this.pushToast(`发送失败：${resp.error}`, "error");
      else void this.syncSessionFile(rt);
    } catch (err) {
      this.pushToast(`发送失败：${errText(err)}`, "error");
    }
  }

  /** Refresh context-window usage from the engine (get_session_stats). */
  async refreshContextUsage(rt: SessionRuntime = this.active) {
    const sid = rt.view.sessionId;
    if (!sid || this.contextInflight) return;
    this.contextInflight = true;
    try {
      const resp = await sendCommand(sid, { type: "get_session_stats" }, 15000);
      if (resp.success) {
        const usage = (resp.data as { contextUsage?: ChatState["contextUsage"] } | undefined)?.contextUsage;
        if (usage !== undefined) this.setRt(rt, { contextUsage: usage });
      }
    } catch {
      // Stats are best-effort UI decoration.
    } finally {
      this.contextInflight = false;
    }
  }

  /** Manually compact the conversation context (engine `compact` command). */
  async compact() {
    const sid = this.rt.view.sessionId;
    if (!sid) {
      this.pushToast("请先开始一段对话", "info");
      return;
    }
    if (this.rt.view.isCompacting) return;
    try {
      const resp = await sendCommand(sid, { type: "compact" });
      if (!resp.success) this.pushToast(`上下文压缩失败：${resp.error}`, "error");
    } catch (err) {
      this.pushToast(`上下文压缩失败：${errText(err)}`, "error");
    }
  }

  async abort() {
    const sid = this.rt.view.sessionId;
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
    if (!this.rt.view.sessionId) return;
    if (this.rt.view.timeline.length === 0) {
      try {
        await this.restartSession(this.rt);
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

    // Optimistic: the picker updates now, the engine catches up. Reverted
    // below if the engine rejects the model.
    const previous = this.rt.view.currentModel;
    const known =
      this.global.models.find((m) => m.provider === provider && m.id === modelId) ??
      this.global.customModels.find((m) => m.provider === provider && m.id === modelId);
    this.set({ currentModel: known ?? ({ id: modelId, name: modelId, provider } as ModelInfo) });
    saveLastModel({ provider, modelId, name: known?.name });

    // No engine yet (e.g. the model is picked before the first message):
    // the preference is saved, and applySavedModel applies it at spawn.
    // Spawning one here is what made switching cost seconds.
    const rt = this.rt;
    if (!rt.view.sessionId) return;

    const revert = () => {
      // Only revert if the user has not picked yet another model since.
      const cur = rt.view.currentModel;
      if (cur?.provider !== provider || cur?.id !== modelId) return;
      this.setRt(rt, { currentModel: previous });
      if (previous) saveLastModel({ provider: previous.provider, modelId: previous.id, name: previous.name });
    };

    try {
      const resp = await sendCommand(rt.view.sessionId, { type: "set_model", provider, modelId }, 15000);
      if (resp.success) {
        this.setRt(rt, { currentModel: resp.data as ModelInfo });
        saveLastModel({ provider, modelId, name: (resp.data as ModelInfo)?.name });
        return;
      }
      // The running engine reads models.json at spawn, so a provider added
      // after this session started is unknown to it. If nothing has been
      // said yet, silently restart the session and retry once.
      const isCustom = this.global.customModels.some(
        (m) => m.provider === provider && m.id === modelId,
      );
      if (isCustom && rt.view.timeline.length === 0) {
        await this.restartSession(rt);
        const sid2 = rt.view.sessionId;
        if (!sid2) throw new Error("session restart failed");
        const retry = await sendCommand(sid2, { type: "set_model", provider, modelId }, 15000);
        if (retry.success) {
          this.setRt(rt, { currentModel: retry.data as ModelInfo });
          saveLastModel({ provider, modelId, name: (retry.data as ModelInfo)?.name });
          return;
        }
        revert();
        this.pushToast(`切换模型失败：${friendlyError(retry.error)}`, "error");
        return;
      }
      revert();
      this.pushToast(`切换模型失败：${friendlyError(resp.error)}`, "error");
    } catch (err) {
      revert();
      this.pushToast(`切换模型失败：${errText(err)}`, "error");
    }
  }

  /** Re-apply the last used model to a freshly spawned engine (best-effort). */
  private async applySavedModel(rt: SessionRuntime) {
    const saved = loadLastModel();
    const sid = rt.view.sessionId;
    if (!saved || !sid) return;
    const cur = rt.view.currentModel;
    if (cur?.provider === saved.provider && cur?.id === saved.modelId) return;
    try {
      const resp = await sendCommand(sid, { type: "set_model", provider: saved.provider, modelId: saved.modelId }, 15000);
      if (resp.success) this.setRt(rt, { currentModel: resp.data as ModelInfo });
    } catch {
      // Saved model no longer available — keep the engine default.
    }
  }

  /** Close the runtime's engine process and spawn a fresh one in the same cwd. */
  private async restartSession(rt: SessionRuntime = this.active) {
    const oldSid = rt.view.sessionId;
    const cwd = rt.view.cwd || localStorage.getItem("kalo.lastCwd") || ".";
    if (oldSid) {
      // Detach BEFORE closeSession so the exit event doesn't trigger recovery.
      this.detachRt(rt);
      try {
        await closeSession(oldSid);
      } catch {
        // Already gone — fine.
      }
    }
    const sid = await this.spawnSession(rt, cwd);
    await this.waitForEngine(sid);
    await this.fetchSessionMeta(rt, sid);
    await this.applySavedModel(rt);
  }

  async cycleThinkingLevel() {
    const rt = this.rt;
    const sid = rt.view.sessionId;
    if (!sid) {
      this.pushToast("请先开始一段对话", "info");
      return;
    }
    // Optimistic: advance locally through the known level table, then let the
    // engine's answer (or thinking_level_changed) confirm it.
    const levels = this.global.thinkingLevels;
    const previous = rt.view.thinkingLevel;
    const i = levels.indexOf(previous);
    if (i !== -1) this.setRt(rt, { thinkingLevel: levels[(i + 1) % levels.length] });

    const resp = await sendCommand(sid, { type: "cycle_thinking_level" });
    if (resp.success) {
      const level = (resp.data as { level: ThinkingLevel } | null)?.level;
      if (level) this.setRt(rt, { thinkingLevel: level });
    } else {
      this.setRt(rt, { thinkingLevel: previous });
      this.pushToast(`切换思考等级失败：${resp.error}`, "error");
    }
  }

  async setSteeringMode(mode: "all" | "one-at-a-time") {
    const rt = this.rt;
    const sid = rt.view.sessionId;
    const previous = rt.view.steeringMode;
    // No engine yet: remember locally, applied implicitly on next session.
    this.setRt(rt, { steeringMode: mode });
    if (!sid) return;
    const resp = await sendCommand(sid, { type: "set_steering_mode", mode });
    if (!resp.success) {
      this.setRt(rt, { steeringMode: previous });
      this.pushToast(`设置权限模式失败：${resp.error}`, "error");
    }
  }

  clearInputDraft() {
    this.set({ inputDraft: undefined });
  }

  /** Answer the current extension UI prompt and pop it from the queue. */
  async respondExtension(id: string, answer: { value: string } | { confirmed: boolean } | { cancelled: true }) {
    const rt = this.rt;
    const sid = rt.view.sessionId;
    this.setRt(rt, { extensionQueue: rt.view.extensionQueue.filter((q) => q.id !== id) });
    if (rt === this.active) this.commit();
    if (!sid) return;
    try {
      await sendRawCommand(sid, { type: "extension_ui_response", id, ...answer });
    } catch (err) {
      this.pushToast(`回复扩展请求失败：${errText(err)}`, "error");
    }
  }

  // --------------------------------------------------------------------------
  // Event dispatch (routed to the owning runtime, parked or active)
  // --------------------------------------------------------------------------

  private handlePiPayload(payload: PiEventPayload, rt: SessionRuntime) {
    if (!payload || typeof payload !== "object") return;
    const type = (payload as { type?: string }).type;

    if (type === "response") {
      resolveResponse(payload as RpcResponse);
      return;
    }
    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(payload as RpcExtensionUIRequest, rt);
      return;
    }
    this.handleAgentEvent(payload as PiEvent, rt);
  }

  private handleExtensionUiRequest(req: RpcExtensionUIRequest, rt: SessionRuntime) {
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
        this.setRt(rt, { extensionQueue: [...rt.view.extensionQueue, prompt] });
        if (rt !== this.active) {
          this.pushToast(`后台会话正在等待交互输入（${prompt.title}），请切换到该会话处理`, "info");
        }
        break;
      }
      case "notify":
        this.pushToast(req.message, req.notifyType ?? "info");
        break;
      case "setTitle":
        document.title = req.title || "Kalo";
        break;
      case "set_editor_text":
        this.setRt(rt, { inputDraft: req.text });
        break;
      case "setStatus":
      case "setWidget":
        // Status lines and widgets are not rendered yet.
        break;
    }
  }

  private handleAgentEvent(ev: PiEvent, rt: SessionRuntime) {
    switch (ev.type) {
      case "agent_start":
        // New run: discard any stale accumulator from a run that never settled.
        rt.runUsage = null;
        rt.runChanges = createAccumulator();
        this.setRt(rt, { isStreaming: true });
        break;
      case "agent_end":
        if (!ev.willRetry) this.setRt(rt, { isStreaming: false });
        void this.refreshContextUsage(rt);
        break;
      case "agent_settled":
        this.setRt(rt, { isStreaming: false, isCompacting: false });
        this.attachRunUsage(rt);
        this.pushRunChanges(rt);
        break;

      case "message_start":
        this.onMessageStart(ev.message, rt);
        break;
      case "message_update":
        this.applyAssistantEvent(ev.assistantMessageEvent, rt);
        break;
      case "message_end":
        this.onMessageEnd(ev.message, rt);
        break;

      case "tool_execution_start":
        this.onToolStart(ev.toolCallId, ev.toolName, ev.args, rt);
        break;
      case "tool_execution_update":
        this.applyToolPartial(ev.toolCallId, ev.partialResult, rt);
        break;
      case "tool_execution_end":
        this.updateToolRecord(
          ev.toolCallId,
          (rec) => {
            const done: ToolCallRecord = {
              ...rec,
              status: ev.isError ? "error" : "success",
              result: ev.result,
            };
            // Fold file mutations into this run's summary while the args and
            // the result are together in one place.
            accumulate(rt.runChanges, done, rt.view.cwd);
            return done;
          },
          rt,
        );
        break;

      case "compaction_start":
        rt.compactionNoticeId = nextEntryId();
        this.setRt(rt, { isCompacting: true });
        this.mutateTimeline(
          (t) => t.push({ id: rt.compactionNoticeId!, kind: "notice", text: "正在压缩上下文…" }),
          rt,
        );
        break;
      case "compaction_end": {
        const text = ev.aborted
          ? "上下文压缩已取消"
          : ev.errorMessage
            ? `上下文压缩失败：${ev.errorMessage}`
            : "上下文已压缩";
        this.setRt(rt, { isCompacting: false });
        void this.refreshContextUsage(rt);
        const noticeId = rt.compactionNoticeId;
        this.mutateTimeline((t) => {
          const idx = t.findIndex((e) => e.id === noticeId);
          if (idx >= 0) t[idx] = { ...t[idx], text } as NoticeEntry;
          else t.push({ id: nextEntryId(), kind: "notice", text });
        }, rt);
        break;
      }

      case "auto_retry_start":
        this.mutateTimeline(
          (t) =>
            t.push({
              id: nextEntryId(),
              kind: "retry",
              attempt: ev.attempt,
              maxAttempts: ev.maxAttempts,
              delayMs: ev.delayMs,
              errorMessage: ev.errorMessage,
            }),
          rt,
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
        }, rt);
        break;

      case "thinking_level_changed":
        this.setRt(rt, { thinkingLevel: ev.level });
        break;
      case "session_info_changed":
        this.setRt(rt, { sessionName: ev.name });
        break;
      case "extension_error":
        this.pushToast(`扩展错误：${ev.error ?? "未知错误"}`, "error");
        break;

      default:
        // turn_start/turn_end/queue_update/bash_execution_update/... need no UI
        // (usage is accumulated on message_end and flushed at agent_settled).
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Message lifecycle
  // --------------------------------------------------------------------------

  private onMessageStart(message: AgentMessage, rt: SessionRuntime) {
    if (message.role === "user") {
      this.mutateTimeline((t) => t.push({ id: nextEntryId(), kind: "user", message }), rt);
    } else if (message.role === "assistant") {
      this.mutateTimeline(
        (t) => t.push({ id: nextEntryId(), kind: "assistant", message: { ...message, content: [] }, streaming: true }),
        rt,
      );
    }
    // toolResult starts are ignored; results arrive via tool_execution_end / message_end
  }

  private onMessageEnd(message: AgentMessage, rt: SessionRuntime) {
    if (message.role === "assistant") {
      // Accumulate token usage for the running agent run (flushed once at
      // agent_settled — a run spans several LLM calls/turns).
      const u = message.usage;
      if (u) {
        rt.runUsage = {
          input: (rt.runUsage?.input ?? 0) + (u.input ?? 0),
          output: (rt.runUsage?.output ?? 0) + (u.output ?? 0),
          cacheRead: (rt.runUsage?.cacheRead ?? 0) + (u.cacheRead ?? 0),
          cacheWrite: (rt.runUsage?.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
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
      }, rt);
    } else if (message.role === "toolResult") {
      // Fallback: fill a tool record that never saw tool_execution_end
      // (e.g. result replayed from a session reload mid-stream).
      const tr = message as ToolResultMessage;
      this.updateToolRecord(
        tr.toolCallId,
        (rec) =>
          rec.status === "running"
            ? { ...rec, status: tr.isError ? "error" : "success", result: { content: tr.content, details: tr.details, isError: tr.isError } }
            : rec,
        rt,
      );
    }
  }

  /** Attach the accumulated run usage to the last assistant entry (run footer). */
  private attachRunUsage(rt: SessionRuntime) {
    if (!rt.runUsage) return;
    const usage = rt.runUsage;
    rt.runUsage = null;
    this.mutateTimeline((t) => {
      for (let i = t.length - 1; i >= 0; i--) {
        const e = t[i];
        if (e.kind === "assistant") {
          t[i] = { ...e, usage };
          return;
        }
      }
    }, rt);
  }

  /**
   * Close the run with a "changed files" card. Nothing changed → no card;
   * an aborted run still gets one, listing whatever already hit disk.
   */
  private pushRunChanges(rt: SessionRuntime) {
    const summary = summarize(rt.runChanges);
    rt.runChanges = createAccumulator();
    if (summary.files.length === 0) return;
    this.mutateTimeline((t) => t.push({ id: nextEntryId(), kind: "changes", ...summary }), rt);
  }

  /**
   * Incremental assembly of the streaming assistant message, keyed on
   * contentIndex: *_start inserts a block, *_delta appends, *_end finalizes.
   *
   * Deltas mutate the entry in place and notify via the throttled flush;
   * discrete lifecycle frames (seed/done/error/start) render immediately.
   */
  private applyAssistantEvent(ev: AssistantMessageEvent, rt: SessionRuntime) {
    // Discrete frames keep the immediate path.
    if (ev.type === "done" || ev.type === "error" || ev.type === "start") {
      this.mutateTimeline((t) => {
        const idx = this.findStreamingAssistant(t);
        if (idx === -1) return;
        const entry = t[idx] as AssistantEntry;
        if (ev.type === "done") t[idx] = { ...entry, message: ev.message };
        else if (ev.type === "error") t[idx] = { ...entry, message: ev.error };
        else t[idx] = { ...entry, message: { ...entry.message, content: [] } };
      }, rt);
      return;
    }

    const t = rt.view.timeline;
    const idx = this.findStreamingAssistant(t);
    if (idx === -1) {
      // No message_start seen; seed from the partial carried by the event.
      const partial = "partial" in ev ? (ev.partial as AssistantMessage) : "message" in ev ? (ev as { message: AssistantMessage }).message : undefined;
      if (partial) {
        this.mutateTimeline(
          (tl) =>
            tl.push({
              id: nextEntryId(),
              kind: "assistant",
              message: { ...partial, content: [...partial.content] },
              streaming: true,
            }),
          rt,
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
    this.queueTimelineFlush(entry.id, rt);
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

  private onToolStart(toolCallId: string, toolName: string, args: any, rt: SessionRuntime) {
    const rec: ToolCallRecord = { toolCallId, toolName, args, status: "running" };
    this.mutateTimeline((t) => {
      const last = t[t.length - 1];
      // Consecutive calls of the same tool collapse into one group.
      if (last?.kind === "toolGroup" && last.toolName === toolName) {
        t[t.length - 1] = { ...last, calls: [...last.calls, rec] };
      } else {
        t.push({ id: nextEntryId(), kind: "toolGroup", toolName, calls: [rec] });
      }
    }, rt);
  }

  /** High-frequency tool progress: mutate in place, flush throttled. */
  private applyToolPartial(toolCallId: string, partialResult: any, rt: SessionRuntime) {
    const t = rt.view.timeline;
    for (let gi = t.length - 1; gi >= 0; gi--) {
      const e = t[gi];
      if (e.kind !== "toolGroup") continue;
      const rec = e.calls.find((c) => c.toolCallId === toolCallId);
      if (!rec) continue;
      rec.partialResult = partialResult;
      this.queueTimelineFlush(e.id, rt);
      return;
    }
  }

  private updateToolRecord(toolCallId: string, fn: (rec: ToolCallRecord) => ToolCallRecord, rt: SessionRuntime) {
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
    }, rt);
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

/** Shallow object/primitive comparison used as useChatSelector's default. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Subscribe to a slice of the store instead of the whole snapshot.
 *
 * The store commits on every streaming flush (~20fps), so components reading
 * the full state re-render at that rate even when nothing they show changed.
 * Selected values are cached and compared (shallow by default), so a commit
 * only re-renders the components whose slice actually moved.
 *
 * The selector must be pure and is read from a ref, so an inline arrow is fine.
 */
export function useChatSelector<T>(
  selector: (s: ChatState) => T,
  isEqual: (a: T, b: T) => boolean = shallowEqual,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;
  const cache = useRef<{ value: T } | null>(null);

  const getSelection = useCallback(() => {
    const next = selectorRef.current(chatStore.getSnapshot());
    const cached = cache.current;
    if (cached && equalRef.current(cached.value, next)) return cached.value;
    cache.current = { value: next };
    return next;
  }, []);

  return useSyncExternalStore(chatStore.subscribe, getSelection);
}
