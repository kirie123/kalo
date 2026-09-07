/**
 * Pure helpers extracted from chat-store.ts.
 *
 * chat-store.ts is over the repo's 800-line budget and may only shrink
 * (scripts/check-file-length.mjs), so anything that does not need the store's
 * private state lives here. Being free of store state also makes these
 * directly unit-testable.
 */

import type { AttachmentDraft, PendingSession } from "../types";

/** Normalize a path for pool keys / file matching (Windows-safe). */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Same-keys-same-values check for the runningByFile flag maps. */
export function sameFlags(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Field-wise comparison of the optimistic session list (identity stability). */
export function samePending(a: PendingSession[], b: PendingSession[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.path === y.path && x.id === y.id && x.title === y.title && x.cwd === y.cwd;
  });
}

/** First line of a prompt, trimmed to a sidebar-sized title. */
export function promptTitle(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line || "新对话";
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Base64 payload of a File, without the `data:...;base64,` prefix. */
export function fileToBase64(file: File): Promise<string> {
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
export function pastedImageName(file: File): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1] || "png";
  return `粘贴图片-${pastedImageCounter++}.${ext}`;
}

/** Attachment names are the chip key and the removal key, so they must be
 *  distinct: a collision gets `(2)`, `(3)`, … before the extension. */
export function uniqueAttachmentName(name: string, existing: AttachmentDraft[]): string {
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

export interface SavedModel {
  provider: string;
  modelId: string;
  name?: string;
}

export function loadLastModel(): SavedModel | null {
  try {
    const raw = localStorage.getItem(LAST_MODEL_KEY);
    return raw ? (JSON.parse(raw) as SavedModel) : null;
  } catch {
    return null;
  }
}

export function saveLastModel(m: SavedModel) {
  localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(m));
}
