/**
 * Thin wrapper over the Tauri IPC contract exposed by the Rust backend.
 *
 * invoke commands (args camelCase):
 *   create_session { cwd } -> string
 *   send_command   { sessionId, command } -> void
 *   close_session  { sessionId } -> void
 *   list_sessions  {} -> ProjectGroup[]
 *   delete_session { path } -> void
 *   read_session_page { path, before?, limit? } -> SessionPage
 *   list_skills / read_skill / write_skill / create_skill / delete_skill
 *   list_memories / read_memory / write_memory / delete_memory
 *   read_models_config / write_models_config / read_auth_config / write_auth_config
 *   gateway_pair_start / gateway_pair_cancel / gateway_status / gateway_unbind
 *   schedule_list / schedule_upsert / schedule_remove / schedule_run
 *   list_knowledge_cards / read_knowledge_card / write_knowledge_card / delete_knowledge_card
 *   read_mcp_config / write_mcp_config / read_mcp_status
 *   jobs_list {} -> JobsSnapshot
 *   list_dir { path } -> DirEntry[]
 *   read_file_text { path, maxBytes? } -> { text, truncated, binary }
 *   read_attachment { path } -> AttachmentDraft (image base64 or text)
 *   open_path { path, reveal } -> void
 *
 * events:
 *   pi-event:{sessionId}  — one stdout JSON line (response or event)
 *   pi-stderr:{sessionId} — string
 *   pi-exit:{sessionId}   — { code: number | null }
 *   gateway-status        — GatewayStatus (sidecar lifecycle, pairing QR)
 *   schedule-status       — ScheduleTaskInfo[] (full task-table snapshot)
 *   schedule-error        — string (async schedule_upsert validation failure)
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AuthConfig,
  AttachmentDraft,
  DirEntry,
  FileMatch,
  FileTextContent,
  GatewayStatus,
  JobsSnapshot,
  KnowledgeCardMeta,
  McpConfig,
  McpStatus,
  MemoryEntry,
  MemoryMeta,
  ModelsConfig,
  PiEventPayload,
  PiExitInfo,
  ProjectGroup,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
  ScheduleTask,
  ScheduleTaskInfo,
  SessionPage,
  SkillMeta,
} from "../types";

// ============================================================================
// Session lifecycle
// ============================================================================

export function createSession(cwd: string): Promise<string> {
  return invoke<string>("create_session", { cwd });
}

export function closeSession(sessionId: string): Promise<void> {
  return invoke<void>("close_session", { sessionId });
}

export function listSessions(): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("list_sessions", {});
}

/** Delete one historical session file (its .jsonl under the sessions root). */
export function deleteSession(path: string): Promise<void> {
  return invoke<void>("delete_session", { path });
}

/**
 * Read a window of a session file (old -> new). Without `before`, the last
 * `limit` messages are returned; `before` is the exclusive right-edge index
 * used to page towards older messages.
 */
export function readSessionPage(path: string, before?: number, limit?: number): Promise<SessionPage> {
  const args: Record<string, unknown> = { path };
  if (before !== undefined) args.before = before;
  if (limit !== undefined) args.limit = limit;
  return invoke<SessionPage>("read_session_page", args);
}

// ============================================================================
// Skills management
// ============================================================================

export function listSkills(cwd?: string): Promise<SkillMeta[]> {
  return invoke<SkillMeta[]>("list_skills", cwd !== undefined ? { cwd } : {});
}

export function readSkill(path: string): Promise<string> {
  return invoke<string>("read_skill", { path });
}

export function writeSkill(path: string, content: string): Promise<void> {
  return invoke<void>("write_skill", { path, content });
}

/** Returns the path of the new SKILL.md; `cwd` is required for project scope. */
export function createSkill(name: string, scope: "user" | "project", cwd?: string): Promise<string> {
  const args: Record<string, unknown> = { name, scope };
  if (cwd !== undefined) args.cwd = cwd;
  return invoke<string>("create_skill", args);
}

export function deleteSkill(path: string): Promise<void> {
  return invoke<void>("delete_skill", { path });
}

// ============================================================================
// Personal memory (~/.kalo/memory)
// ============================================================================

export function listMemories(): Promise<MemoryMeta[]> {
  return invoke<MemoryMeta[]>("list_memories", {});
}

export function readMemory(slug: string): Promise<MemoryEntry> {
  return invoke<MemoryEntry>("read_memory", { slug });
}

/** Create (omit `slug`) or overwrite a memory; resolves to the slug. */
export function writeMemory(slug: string | undefined, title: string, tags: string[], content: string): Promise<string> {
  const args: Record<string, unknown> = { title, tags, content };
  if (slug !== undefined) args.slug = slug;
  return invoke<string>("write_memory", args);
}

export function deleteMemory(slug: string): Promise<void> {
  return invoke<void>("delete_memory", { slug });
}

// ============================================================================
// Engine configuration (~/.kalo/agent/models.json + auth.json)
// ============================================================================

export function readModelsConfig(): Promise<ModelsConfig> {
  return invoke<ModelsConfig>("read_models_config", {});
}

export function writeModelsConfig(config: ModelsConfig): Promise<void> {
  return invoke<void>("write_models_config", { config });
}

export function readAuthConfig(): Promise<AuthConfig> {
  return invoke<AuthConfig>("read_auth_config", {});
}

export function writeAuthConfig(config: AuthConfig): Promise<void> {
  return invoke<void>("write_auth_config", { config });
}

// ============================================================================
// Filesystem browsing + attachments
// ============================================================================

/** Single-level listing; dirs first, hidden/build dirs filtered server-side. */
export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

export function readFileText(path: string, maxBytes?: number): Promise<FileTextContent> {
  const args: Record<string, unknown> = { path };
  if (maxBytes !== undefined) args.maxBytes = maxBytes;
  return invoke<FileTextContent>("read_file_text", args);
}

export function readAttachment(path: string): Promise<AttachmentDraft> {
  return invoke<AttachmentDraft>("read_attachment", { path });
}

/** Open with the system default app (reveal=false) or show in the OS file manager (reveal=true). */
export function openPath(path: string, reveal = false): Promise<void> {
  return invoke<void>("open_path", { path, reveal });
}

/** Name search under root for the input box's @ completion. */
export function searchFiles(root: string, query: string): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("search_files", { root, query });
}

// ============================================================================
// IM gateway sidecar (Feishu)
// ============================================================================

/** Start QR pairing: spawns the gateway if needed and begins device-flow registration. */
export function gatewayPairStart(): Promise<void> {
  return invoke<void>("gateway_pair_start", {});
}

/** Cancel an in-flight pairing attempt. */
export function gatewayPairCancel(): Promise<void> {
  return invoke<void>("gateway_pair_cancel", {});
}

/** Current gateway snapshot (state, bound user, pairing detail). */
export function gatewayStatus(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("gateway_status", {});
}

/** Delete stored credentials and stop the gateway. */
export function gatewayUnbind(): Promise<void> {
  return invoke<void>("gateway_unbind", {});
}

/** Subscribe to `gateway-status` push updates (pairing QR, state changes). */
export function onGatewayStatus(cb: (status: GatewayStatus) => void) {
  return listen<GatewayStatus>("gateway-status", (e) => cb(e.payload));
}

// ============================================================================
// Task scheduler (gateway sidecar)
// ============================================================================

/** Cached task-table snapshot; a fresh copy is pushed via `schedule-status`. */
export function scheduleList(): Promise<ScheduleTaskInfo[]> {
  return invoke<ScheduleTaskInfo[]>("schedule_list", {});
}

/**
 * Create or replace one task (whole object). Invalid input does not reject
 * here — the gateway reports it asynchronously as a `schedule-error` event.
 */
export function scheduleUpsert(task: ScheduleTask): Promise<void> {
  return invoke<void>("schedule_upsert", { task });
}

export function scheduleRemove(id: string): Promise<void> {
  return invoke<void>("schedule_remove", { id });
}

/** Fire a task right now, ignoring its enabled flag and cooldown. */
export function scheduleRun(id: string): Promise<void> {
  return invoke<void>("schedule_run", { id });
}

/** Subscribe to `schedule-status` full task-table snapshots. */
export function onScheduleStatus(cb: (tasks: ScheduleTaskInfo[]) => void) {
  return listen<ScheduleTaskInfo[]>("schedule-status", (e) => cb(e.payload));
}

/** Subscribe to `schedule-error` (async validation failures of schedule_upsert). */
export function onScheduleError(cb: (message: string) => void) {
  return listen<string>("schedule-error", (e) => cb(e.payload));
}

// ============================================================================
// MCP servers (~/.kalo/agent/mcp.json + engine-written status)
// ============================================================================

export function readMcpConfig(): Promise<McpConfig> {
  return invoke<McpConfig>("read_mcp_config", {});
}

export function writeMcpConfig(config: McpConfig): Promise<void> {
  return invoke<void>("write_mcp_config", { config });
}

/** Engine handshake mirror; empty servers until a session has run. */
export function readMcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("read_mcp_status", {});
}

// ============================================================================
// Job center (P1-B)
// ============================================================================

/** Running engine sessions + latest gateway task snapshot. */
export function jobsList(): Promise<JobsSnapshot> {
  return invoke<JobsSnapshot>("jobs_list", {});
}

// ============================================================================
// Knowledge base (~/.kalo/knowledge)
// ============================================================================

export function listKnowledgeCards(): Promise<KnowledgeCardMeta[]> {
  return invoke<KnowledgeCardMeta[]>("list_knowledge_cards", {});
}

/** Full markdown text of one card. */
export function readKnowledgeCard(relPath: string): Promise<string> {
  return invoke<string>("read_knowledge_card", { relPath });
}

/**
 * Create (omit `relPath` → `<domain>/<slug>.md`, fails when it already
 * exists) or overwrite a card; resolves to the actual rel path.
 */
export function writeKnowledgeCard(
  relPath: string | undefined,
  domain: string,
  title: string,
  content: string,
): Promise<string> {
  const args: Record<string, unknown> = { domain, title, content };
  if (relPath !== undefined) args.relPath = relPath;
  return invoke<string>("write_knowledge_card", args);
}

export function deleteKnowledgeCard(relPath: string): Promise<void> {
  return invoke<void>("delete_knowledge_card", { relPath });
}

// ============================================================================
// Command channel with request/response correlation
// ============================================================================

let nextRequestId = 1;
const pending = new Map<string, { sessionId: string; resolve: (resp: RpcResponse) => void; reject: (err: Error) => void }>();

/**
 * Send an RPC command and wait for its correlated response.
 * An incrementing `id` is attached; the engine echoes it on the response,
 * which the chat store routes back here via `resolveResponse`.
 *
 * With `timeoutMs`, the promise rejects if no response arrives in time —
 * used for readiness probes, since the engine drops commands received
 * before its dispatch loop is up.
 */
export async function sendCommand(
  sessionId: string,
  command: RpcCommand,
  timeoutMs?: number,
): Promise<RpcResponse> {
  const id = `kalo-${nextRequestId++}`;
  const wire = { ...command, id };
  const promise = new Promise<RpcResponse>((resolve, reject) => {
    pending.set(id, { sessionId, resolve, reject });
    if (timeoutMs !== undefined) {
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error("engine response timeout"));
      }, timeoutMs);
    }
  });
  try {
    await invoke<void>("send_command", { sessionId, command: wire });
  } catch (err) {
    pending.delete(id);
    throw err;
  }
  return promise;
}

/**
 * Settle every in-flight command of a session with an error.
 * Called when the engine process exits — pending requests must get a
 * definitive outcome instead of hanging forever.
 */
export function rejectSessionPending(sessionId: string, err: Error) {
  for (const [id, p] of pending) {
    if (p.sessionId !== sessionId) continue;
    pending.delete(id);
    p.reject(err);
  }
}

/**
 * Send a raw JSON object without correlation (no waiting for a response).
 * Used for extension_ui_response, whose `id` must be the engine-issued
 * request id, not one of ours.
 */
export async function sendRawCommand(sessionId: string, command: RpcExtensionUIResponse): Promise<void> {
  await invoke<void>("send_command", { sessionId, command });
}

/**
 * Called by the chat store for every `type: "response"` payload.
 * Returns true when a pending request was completed.
 */
export function resolveResponse(resp: RpcResponse): boolean {
  if (!resp.id) return false;
  const entry = pending.get(resp.id);
  if (!entry) return false;
  pending.delete(resp.id);
  entry.resolve(resp);
  return true;
}

// ============================================================================
// Event subscriptions (callers must invoke the returned unlisten on cleanup)
// ============================================================================

export function onPiEvent(sessionId: string, cb: (payload: PiEventPayload) => void) {
  return listen<PiEventPayload>(`pi-event:${sessionId}`, (e) => cb(e.payload));
}

export function onPiStderr(sessionId: string, cb: (line: string) => void) {
  return listen<string>(`pi-stderr:${sessionId}`, (e) => cb(e.payload));
}

export function onPiExit(sessionId: string, cb: (info: PiExitInfo) => void) {
  return listen<PiExitInfo>(`pi-exit:${sessionId}`, (e) => cb(e.payload));
}
