/**
 * Mirror of the pi engine RPC protocol (NDJSON over stdin/stdout).
 * Source: pi/packages/coding-agent/src/modes/rpc/rpc-types.ts
 * plus message/event types from @earendil-works/pi-ai and pi-agent-core.
 */

// ============================================================================
// Message content
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
  namespace?: string;
  /** Frontend-only: raw streamed JSON fragment before toolcall_end arrives. */
  _rawArgs?: string;
}

// ============================================================================
// Messages
// ============================================================================

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
    [key: string]: any;
  };
  stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

// ============================================================================
// Model
// ============================================================================

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: any;
}

// ============================================================================
// Assistant streaming events (payload of message_update)
// ============================================================================

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
  // Prompting
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  // State
  | { id?: string; type: "get_state" }
  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  // Thinking
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_available_thinking_levels" }
  // Queue modes
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  // Retry
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }
  // Bash
  | { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
  | { id?: string; type: "abort_bash" }
  // Session
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "get_entries"; since?: string }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  // Messages
  | { id?: string; type: "get_messages" }
  // Commands
  | { id?: string; type: "get_commands" };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
  model?: ModelInfo;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

export type RpcResponse =
  | { id?: string; type: "response"; command: "prompt" | "steer" | "follow_up" | "abort"; success: true; data?: any }
  | { id?: string; type: "response"; command: "new_session" | "switch_session" | "clone"; success: true; data: { cancelled: boolean } }
  | { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
  | { id?: string; type: "response"; command: "set_model"; success: true; data: ModelInfo }
  | { id?: string; type: "response"; command: "cycle_model"; success: true; data: { model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null }
  | { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: ModelInfo[] } }
  | { id?: string; type: "response"; command: "set_thinking_level"; success: true; data?: any }
  | { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }
  | { id?: string; type: "response"; command: "get_available_thinking_levels"; success: true; data: { levels: ThinkingLevel[] } }
  | { id?: string; type: "response"; command: "set_steering_mode" | "set_follow_up_mode" | "set_auto_compaction" | "set_auto_retry" | "abort_retry" | "abort_bash" | "set_session_name"; success: true; data?: any }
  | { id?: string; type: "response"; command: "compact"; success: true; data?: any }
  | { id?: string; type: "response"; command: "bash"; success: true; data: { output?: string; exitCode?: number; [key: string]: any } }
  | { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
  | { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }
  // Generic success for commands we don't consume the data of
  | { id?: string; type: "response"; command: string; success: true; data?: any }
  // Error response (any command can fail)
  | { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Agent / session events (stdout)
// ============================================================================

export type PiEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry?: boolean }
  | { type: "agent_settled" }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
  // Queue
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  // Compaction
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: any; aborted: boolean; willRetry: boolean; errorMessage?: string }
  // Auto retry
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  // Misc session events
  | { type: "extension_error"; error?: string; [key: string]: any }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "session_info_changed"; name?: string }
  | { type: "bash_execution_update"; id?: string; delta: string };

// ============================================================================
// Extension UI
// ============================================================================

export type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Tauri IPC contract
// ============================================================================

/** Payload of the `pi-event:{sessionId}` Tauri event: one stdout JSON line. */
export type PiEventPayload = PiEvent | RpcResponse | RpcExtensionUIRequest;

export interface SessionSummary {
  path: string;
  id: string;
  timestamp: number;
  title: string;
  modifiedMs: number;
}

export interface ProjectGroup {
  cwd: string;
  sessions: SessionSummary[];
}

/**
 * A session an engine has already started but that `list_sessions` cannot see
 * yet: pi only writes the `.jsonl` once the first assistant message lands, so
 * a run that thinks for a minute would otherwise be invisible in the sidebar
 * for that whole minute. The store publishes these and the sidebar list merges
 * them in, deduped by path against the on-disk scan.
 */
export interface PendingSession {
  /** Engine-allocated session file, or `pending:<runtime key>` before it is known. */
  path: string;
  /** Engine session id, so the active-session highlight matches. */
  id: string;
  title: string;
  cwd: string;
  modifiedMs: number;
}

/** One page of a session file, messages ordered old -> new. */
export interface SessionPage {
  messages: AgentMessage[];
  /** Index of messages[0] within the full session (window left edge). */
  start: number;
  total: number;
  hasMore: boolean;
}

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project";
  isDir: boolean;
}

/**
 * Outcome of installing the bundled `internal-skills/` into ~/.kalo/skills.
 * Entries are skill-relative paths (`math/SKILL.md`); `skipped` are the ones
 * carrying local edits, which a non-forced install leaves alone.
 */
export interface SkillInstallReport {
  installed: string[];
  updated: string[];
  skipped: string[];
}

/**
 * State of the market-data run environment, as reported by executing the
 * `~/.kalo/market/py` shim (see `src-tauri/src/market_env.rs`).
 *
 * `ready` is the only field the card branches on: an interpreter was resolved
 * **and** every dependency imports there. Everything else exists to tell the
 * user which of the shim's routes won, so a wrong answer is diagnosable.
 */
export interface MarketEnv {
  ready: boolean;
  python: string | null;
  version: string | null;
  /** `override` | `venv` | `uv` | `system` | `none` */
  route: string;
  venv: string | null;
  shim: string;
  shimState: "installed" | "updated" | "unchanged" | "userEdited";
  /** Module name → importable. */
  deps: Record<string, boolean>;
  /** Just the missing ones, most-fundamental-first. */
  missing: string[];
  detail: string;
  /** Why the probe itself failed (no bash, no Python at all, …). */
  error: string | null;
}

/** One memory's index metadata (frontmatter + summary, no body). */
export interface MemoryMeta {
  slug: string;
  title: string;
  tags: string[];
  summary: string;
  updated: string;
  path: string;
}

/** A full memory entry including its body (`content`). */
export interface MemoryEntry {
  slug: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  content: string;
}

export interface PiExitInfo {
  code: number | null;
}

/** One engine slash command (extension command, skill:, or prompt template). */
export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
}

/** One name match from search_files (@ completion). */
export interface FileMatch {
  name: string;
  path: string;
  isDir: boolean;
}

/** One entry of a single-level directory listing (`list_dir`). */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

/** Result of `read_file_text`. */
export interface FileTextContent {
  text: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * One changed path from `git_status`. Mirrors `src-tauri/src/git.rs`, which
 * builds it from `git status --porcelain=v2`.
 */
export interface GitEntry {
  /** Relative to `repoRoot`, posix separators (as git prints it). */
  relPath: string;
  /** Absolute path, native separators — matches what `list_dir` returns. */
  path: string;
  /** Staged-side status letter; "." when unmodified. */
  index: string;
  /** Work-tree-side status letter; "." when unmodified. */
  worktree: string;
  untracked: boolean;
  /** An entirely untracked directory, collapsed by git into one entry. */
  isDir: boolean;
  conflicted: boolean;
  submodule: boolean;
  renamedFrom?: string;
  added?: number;
  removed?: number;
  binary: boolean;
}

/**
 * Working-tree snapshot from `git_status`. The command answers `null` when the
 * directory is not a repository (or git is missing) — a normal state, not an
 * error.
 */
export interface GitStatus {
  repoRoot: string;
  /** Branch name, or a short oid when detached. */
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** True before the first commit exists. */
  initial: boolean;
  entries: GitEntry[];
  /** True when the entry list was capped and is only a prefix. */
  truncated: boolean;
}

/** `app_paths` result: stable locations for building commands. */
export interface AppPaths {
  home: string;
  /** `~/.kalo` */
  kaloRoot: string;
  /** Absolute path to the bundled engine binary; "" when not found. */
  engineBin: string;
}

/** `read_text_since` result: an incremental slice of an append-only file. */
export interface TextSince {
  text: string;
  /** Offset to pass on the next call. */
  offset: number;
  size: number;
  /** True when the file shrank and this read restarted from 0. */
  reset: boolean;
}

/** `dir_diff_names` result: relative paths that differ between two trees. */
export interface DirDiff {
  changed: string[];
  added: string[];
  removed: string[];
  /** True when the walk hit its entry cap; lists are a prefix. */
  truncated: boolean;
}

/**
 * Attachment draft, mirroring the `read_attachment` union (serde tag=kind).
 *
 * Images go to the engine as ImageContent — attaching a picture means the
 * model should see it, and a pasted screenshot has no path anyway. Everything
 * else is a path reference: `sendPrompt` lists it in an `<attachments>` tag
 * and the model reads the file itself, so document contents never enter the
 * prompt. See `lib/attachments.ts` for the tag.
 *
 * `sourcePath` on an image is added on the frontend when the draft came from a
 * real file (picker / drag-drop), so the chip can show where it came from.
 * Pasted bitmaps have no path, hence optional.
 */
export type AttachmentDraft =
  | { kind: "image"; name: string; mimeType: string; dataBase64: string; sourcePath?: string }
  | { kind: "file"; name: string; path: string };

// ============================================================================
// pi engine configuration (~/.kalo/agent/models.json + auth.json)
// ============================================================================

/** Wire API dialect spoken by a custom provider. */
export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ProviderModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  compat?: ProviderCompat;
}

export interface ProviderCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
}

/** One entry of models.json `providers`. */
export interface ProviderConfig {
  baseUrl: string;
  api: ProviderApi;
  apiKey?: string;
  compat?: ProviderCompat;
  models: ProviderModelDef[];
}

/** Contents of ~/.kalo/agent/models.json. */
export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

/** One credential entry of ~/.kalo/agent/auth.json. */
export interface AuthCredential {
  type: string;
  key?: string;
  [key: string]: unknown;
}

/** Contents of ~/.kalo/agent/auth.json. */
export type AuthConfig = Record<string, AuthCredential>;

/**
 * Contents of ~/.kalo/onboarding.json — the first-run tour's marker.
 *
 * A file rather than localStorage so clearing the webview's storage does not
 * re-show the tour, and so deleting it by hand is how you ask to see it again.
 * `version` is written but not read yet: it is there so a future release that
 * adds steps can decide whether an old marker still counts.
 */
export interface OnboardingState {
  completed?: boolean;
  completedAt?: number;
  version?: number;
}

// ============================================================================
// IM gateway (Feishu sidecar)
// ============================================================================

/** Lifecycle of the gateway sidecar as reported via `gateway-status` events. */
export type GatewayState =
  | "starting"
  | "disconnected"
  | "pairing"
  | "connecting"
  | "connected"
  | "error"
  | "unavailable";

/** Payload of the `gateway-status` Tauri event (and `gateway_status` command). */
export interface GatewayStatus {
  state: GatewayState;
  /** Bound Feishu open_id once connected. */
  user?: string;
  /** Human-readable detail (error text, connection notes). */
  message?: string;
  /** Data-URL QR image while pairing. */
  qrDataUrl?: string;
  /** QR validity in seconds while pairing. */
  expiresIn?: number;
}

// ============================================================================
// Task scheduler (gateway sidecar, mirrors ~/.kalo/agent/schedules.json)
// ============================================================================

export type ScheduleTaskKind = "watch" | "agent";
export type ScheduleTaskResult = "ok" | "alerted" | "error";

/** One scheduled task; `schedule_upsert` takes this whole object. */
export interface ScheduleTask {
  /** [\w-]{1,64}, stable handle. */
  id: string;
  name: string;
  /** watch = local script, zero-token alert; agent = headless LLM session. */
  kind: ScheduleTaskKind;
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
  /** agent: "provider/modelId", null/undefined = default model. */
  model?: string | null;
  enabled: boolean;
  /** ISO timestamp of the last run. */
  lastRun?: string;
  lastResult?: ScheduleTaskResult;
}

/**
 * Payload of the `schedule-status` Tauri event (and `schedule_list` command):
 * a full task-table snapshot, each row plus its computed next run
 * (null while disabled).
 */
export interface ScheduleTaskInfo extends ScheduleTask {
  nextRunAt: string | null;
}

// ============================================================================
// Feeds (gateway sidecar, mirrors ~/.kalo/feeds/<id>.json)
// ============================================================================

/** Where a feed's values surface. M1 renders `ticker` only. */
export type FeedSurface = "ticker" | "card" | "alert" | "note";

/**
 * One field extractor. Exactly one of path/regex/index/const applies; the
 * remaining keys shape the value (see the gateway's feeds.ts for the rules).
 */
export interface FeedField {
  /** JSON dotted path; numeric segments index arrays. */
  path?: string;
  /** Text: first match of this pattern, capture group `group` (default 1). */
  regex?: string;
  group?: number;
  /** Text: split the row by `sep`, take segment `index`. */
  index?: number;
  sep?: string;
  /** Literal text. */
  const?: string;
  scale?: number;
  digits?: number;
  plus?: boolean;
  prefix?: string;
  suffix?: string;
}

/** One feed spec; `feed_upsert` takes this whole object. */
export interface FeedSpec {
  /** [\w-]{1,64}, also the file name. */
  id: string;
  name: string;
  /** Pull interval in seconds (minimum 5). */
  everySec: number;
  surface: FeedSurface;
  enabled: boolean;
  request: {
    url: string;
    /** Response charset; GBK is common on Chinese quote endpoints. */
    encoding?: "utf-8" | "gbk";
    headers?: Record<string, string>;
  };
  /** Split the response into rows: JSON array path, or text separator. */
  rows?: { path?: string; split?: string };
  fields: Record<string, FeedField>;
  /** Row template; `{field}` placeholders get the extracted values. */
  template: string;
  /** Field whose sign drives the up/down color. */
  trendField?: string;
}

export type FeedTrend = "up" | "down" | "flat";

export interface FeedItem {
  text: string;
  trend: FeedTrend | null;
}

/** Result of one pull (mirrors ~/.kalo/feeds/state/<id>.json). */
export interface FeedSnapshot {
  id: string;
  at: string;
  ok: boolean;
  ms: number;
  /** On failure these are the last good values — see `stale`. */
  items: FeedItem[];
  error?: string;
  /** True when `items` predate the latest pull. */
  stale?: boolean;
}

/** Payload of the `feed-status` event (and the `feed_list` command). */
export interface FeedInfo extends FeedSpec {
  snapshot: FeedSnapshot | null;
  nextPullAt: string | null;
  consecutiveFailures: number;
}

// ============================================================================
// Knowledge base (~/.kalo/knowledge)
// ============================================================================

/** One knowledge card's index metadata (frontmatter + derived, no body). */
export interface KnowledgeCardMeta {
  title: string;
  /** Top-level directory the note lives in; "" for root-level notes. */
  domain: string;
  tags: string[];
  date: string;
  /** Last substantive edit, stamped by write_knowledge_card. */
  updated: string;
  /** seed | active | stable | stale, or "" when unset. */
  status: string;
  /** `_by` frontmatter — who wrote it. "" means the user. */
  by: string;
  /** `_reviewed` frontmatter; null when the card has no review state. */
  reviewed: boolean | null;
  /** Body length in characters (CJK counts per character). */
  wordCount: number;
  /** First body line that is neither blank nor a heading. */
  snippet: string;
  /** Path relative to the knowledge root (forward slashes); the stable handle used by all commands. */
  relPath: string;
  /** Absolute path. */
  path: string;
}

/**
 * A domain is a top-level directory. `_types/<key>.md` may decorate it, but
 * the directory is the source of truth — a missing type note just means the
 * label falls back to the key.
 */
export interface KnowledgeDomain {
  key: string;
  label: string;
  /** "" when the type note omits it. */
  icon: string;
  color: string;
  /** Unspecified sorts last. */
  order: number;
  count: number;
}

/** One matching line from search_knowledge. */
export interface KnowledgeSearchHit {
  relPath: string;
  title: string;
  /** 1-based line number. */
  line: number;
  snippet: string;
}

// ============================================================================
// MCP servers (~/.kalo/agent/mcp.json, engine-side stdio clients)
// ============================================================================

/** One MCP server definition; enabled defaults to true. */
export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

/** Shape of mcp.json: { servers: { [name]: McpServerDef } }. */
export interface McpConfig {
  servers: Record<string, McpServerDef>;
}

/** Engine-written handshake result per server (mcp-status.json). */
export interface McpServerStatus {
  ok: boolean;
  tools: Array<{ name: string; description?: string }>;
  error?: string;
}

export interface McpStatus {
  servers: Record<string, McpServerStatus>;
  updatedAt: string | null;
}

// ============================================================================
// Job center (P1-B: running sessions + gateway task table)
// ============================================================================

/** One running engine session in the job center. */
export interface RunningJobSession {
  id: string;
  kind: "session";
  name: string;
  /** desktop | gateway */
  source: string;
  cwd: string;
  state: "running";
  /** Unix seconds (string) — engine spawn time. */
  startedAt: string;
}

/** jobs_list payload: live sessions plus the latest task snapshot. */
export interface JobsSnapshot {
  running: RunningJobSession[];
  tasks: ScheduleTaskInfo[];
}

// ----------------------------------------------------------------------------
// Background command jobs (gateway job runtime, P0-1)
// ----------------------------------------------------------------------------

/** Mirrors the gateway's `JobStatus` (gateway/src/jobs/types.ts). */
export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed";

/** True for the three terminal statuses. */
export function isJobTerminal(s: BackgroundJobStatus): boolean {
  return s === "completed" || s === "killed" || s === "failed";
}

/** A bash probe: exit code 0 passes. Entirely user-authored. */
export interface JobProbe {
  script: string;
  intervalSec: number;
}

/** A log rule: regex whose first capture group becomes a metric value. */
export interface JobRule {
  match: string;
  metric?: string;
}

/** What `job_start` accepts. */
export interface JobStartInput {
  label: string;
  cwd: string;
  cmd: string;
  env?: Record<string, string>;
  /** Pre-launch gate: the job stays `queued` until this passes. */
  gate?: JobProbe;
  health?: JobProbe;
  rules?: JobRule[];
  /** Id prefix; defaults to `gateway`. */
  kind?: string;
  owner?: string;
}

/** Read-only projection of one background job. */
export interface BackgroundJob {
  id: string;
  kind: string;
  label: string;
  ownerSession?: string;
  status: BackgroundJobStatus;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  reported: boolean;
}
