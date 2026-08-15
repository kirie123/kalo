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
 * Attachment draft, mirroring the `read_attachment` union (serde tag=kind).
 * Images go to the engine as ImageContent; text is appended to the prompt.
 */
export type AttachmentDraft =
  | { kind: "image"; name: string; mimeType: string; dataBase64: string }
  | { kind: "text"; name: string; text: string; truncated: boolean };

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
