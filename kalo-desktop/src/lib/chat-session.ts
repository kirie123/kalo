import type { AgentMessage, ModelInfo } from "../types";
import type { ChatState } from "./chat-store";
import { createAccumulator, type ChangeAccumulator } from "./changed-files";
import { loadLastModel } from "./chat-store-helpers";
import type { TurnUsage } from "./timeline";
export type SessionView = Pick<
  ChatState,
  | "sessionId"
  | "engineSessionId"
  | "cwd"
  | "expertId"
  | "sessionName"
  | "timeline"
  | "todos"
  | "history"
  | "loadingOlder"
  | "isStreaming"
  | "isCompacting"
  | "currentModel"
  | "thinkingLevel"
  | "steeringMode"
  | "permissionMode"
  | "extensionQueue"
  | "pendingAsk"
  | "inputDraft"
  | "attachments"
  | "inputQueue"
  | "contextUsage"
  | "sessionFile"
  | "connecting"
>;

/** Session-scoped fields reset for every fresh runtime. */
function freshView(cwd = "", expertId?: string): SessionView {
  const saved = loadLastModel();
  return {
    sessionId: null,
    cwd,
    expertId,
    timeline: [],
    todos: [],
    loadingOlder: false,
    isStreaming: false,
    isCompacting: false,
    currentModel: saved ? ({ id: saved.modelId, name: saved.name || saved.modelId, provider: saved.provider } as ModelInfo) : undefined,
    thinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    permissionMode: undefined,
    extensionQueue: [],
    pendingAsk: undefined,
    attachments: [],
    inputQueue: [],
    contextUsage: undefined,
  };
}

/**
 * One pooled engine session: the view state above plus everything needed to
 * keep it alive in the background (event routing, history window, recovery).
 * Switching sessions never tears a runtime down — only pool eviction,
 * deliberate restart, or app exit kills its engine process.
 */
export class SessionRuntime {
  /**
   * Pool key: normalized session file path once known, else `fresh-N`.
   * Re-keyed by the store when the engine reports its session file.
   */
  key: string;
  /**
   * Stable per-conversation identity for per-session UI memory
   * (doc/2026-09-30-文件面板按会话记忆.md): taken from the initial key and
   * never re-keyed, so `fresh-N` keeps naming the same conversation after the
   * engine reports its session file and the pool key moves to that path.
   */
  uid: string;
  view: SessionView;
  /** Tauri event unlisteners for this runtime's engine process. */
  unlisteners: Array<() => void> = [];
  /** Generation guard: bumps on restart/teardown so stale callbacks no-op. */
  token = 0;
  /** Engine exited before any message was persisted — nothing to recover from. */
  dead = false;
  /** Background tasks / unreceived results; independent of main-turn streaming. */
  backgroundKeepAlive = false;
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
  /**
   * Set on the first prompt of a brand-new chat: pi does not write the session
   * file until the first assistant message, so the sidebar's disk scan cannot
   * see this session yet. Published as a PendingSession until then. Undefined
   * for resumed sessions (already on disk) and for chats never prompted.
   */
  pending: { title: string; at: number } | null = null;
  /** Background engine connect of a resume; sendPrompt awaits it. */
  resumePromise: Promise<void> | null = null;
  compactionNoticeId: string | null = null;
  lastActive = Date.now();
  /** Per-runtime lock: prevents concurrent get_session_stats IPC calls. */
  contextInflight = false;
  /**
   * A prompt is on its way to the engine but `agent_start` has not come back
   * yet. Counts as "running" for the input queue, so a message typed inside
   * that window queues instead of racing the run that is about to start.
   */
  dispatching = false;
  /** 用户刚按了停止：本次 settled 不自动发队列（停止 = 别再自己动）。 */
  queueHold = false;
  // Per-runtime stream batching (20fps clone flush).
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  pendingClones = new Set<string>();

  /**
   * `expertId` in the view is passed to create_session on every
   * spawn, including crash recovery, so a recovered engine keeps the expert
   * identity.
   */
  constructor(key: string, cwd = "", expertId?: string) {
    this.key = key;
    this.uid = key;
    this.view = freshView(cwd, expertId);
  }
}
