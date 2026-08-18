/**
 * Chat-area zoom: Shift(或 Ctrl)+滚轮 scales the conversation column only —
 * the sidebar, header and settings keep their native size.
 *
 * Kept in a tiny external store (not chat-store) because the value is pure UI
 * state shared by MessageList and InputBox, and it changes far less often than
 * the timeline.
 */

import { useSyncExternalStore } from "react";

const KEY = "kalo.chat.zoom";
export const MIN_ZOOM = 0.8;
export const MAX_ZOOM = 1.6;
export const ZOOM_STEP = 0.1;

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

/**
 * First-run default: on a roomy window the 768px column looks tiny, so start
 * bigger. Never above 1.3 — beyond that the line length gets uncomfortable.
 */
function defaultZoom(): number {
  const w = typeof window === "undefined" ? 1280 : window.innerWidth;
  if (w >= 1900) return 1.3;
  if (w >= 1600) return 1.2;
  if (w >= 1280) return 1.1;
  return 1;
}

function loadZoom(): number {
  const raw = localStorage.getItem(KEY);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? clamp(v) : defaultZoom();
}

let zoom = loadZoom();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): number {
  return zoom;
}

/** Set an absolute zoom (clamped) and persist it. Returns the applied value. */
export function setChatZoom(next: number): number {
  const v = clamp(next);
  if (v === zoom) return v;
  zoom = v;
  localStorage.setItem(KEY, String(v));
  listeners.forEach((fn) => fn());
  return v;
}

/** Step the zoom by `delta` steps (+1 = one notch bigger). */
export function stepChatZoom(delta: number): number {
  return setChatZoom(zoom + delta * ZOOM_STEP);
}

/** Back to the size-aware default, and drop the stored override. */
export function resetChatZoom(): void {
  localStorage.removeItem(KEY);
  zoom = defaultZoom();
  listeners.forEach((fn) => fn());
}

export function useChatZoom(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
