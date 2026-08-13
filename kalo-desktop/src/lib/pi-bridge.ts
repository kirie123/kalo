/**
 * Thin wrapper over the Tauri IPC contract exposed by the Rust backend.
 *
 * invoke commands (args camelCase):
 *   create_session { cwd } -> string
 *   send_command   { sessionId, command } -> void
 *   close_session  { sessionId } -> void
 *   list_sessions  {} -> ProjectGroup[]
 *   read_session_page { path, before?, limit? } -> SessionPage
 *   list_skills / read_skill / write_skill / create_skill / delete_skill
 *   read_models_config / write_models_config / read_auth_config / write_auth_config
 *   list_dir { path } -> DirEntry[]
 *   read_file_text { path, maxBytes? } -> { text, truncated, binary }
 *   read_attachment { path } -> AttachmentDraft (image base64 or text)
 *
 * events:
 *   pi-event:{sessionId}  — one stdout JSON line (response or event)
 *   pi-stderr:{sessionId} — string
 *   pi-exit:{sessionId}   — { code: number | null }
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AuthConfig,
  AttachmentDraft,
  DirEntry,
  FileTextContent,
  ModelsConfig,
  PiEventPayload,
  PiExitInfo,
  ProjectGroup,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
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
// Engine configuration (~/.pi/agent/models.json + auth.json)
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

// ============================================================================
// Command channel with request/response correlation
// ============================================================================

let nextRequestId = 1;
const pending = new Map<string, (resp: RpcResponse) => void>();

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
    pending.set(id, resolve);
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
  const resolver = pending.get(resp.id);
  if (!resolver) return false;
  pending.delete(resp.id);
  resolver(resp);
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
