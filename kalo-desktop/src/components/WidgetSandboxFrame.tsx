/**
 * WidgetSandboxFrame — mounts the show_widget sandbox document (srcDoc iframe)
 * and talks to it over postMessage.
 *
 * The document itself (CSP, theme vars, bridge, stream/finalize renderer) lives
 * in src/lib/widget-sandbox.ts. The frame is sandboxed with "allow-scripts" and
 * deliberately without "allow-same-origin", so the widget runs in an opaque
 * origin: no storage, no Tauri IPC, no reach back into the app.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { WidgetSummary } from "../lib/widgets";
import {
  buildSandboxHtml,
  sanitizeForIframe,
  sanitizeForStreaming,
} from "../lib/widget-sandbox";

/** Imperative handle: WidgetCard's menu calls capture() to export a PNG. */
export interface WidgetFrameHandle {
  /** Rasterize the current render to a PNG data URL, or null if it can't. */
  capture: () => Promise<string | null>;
}

/**
 * Host theme token → engine `--cb-*` var. The engine's widgets take every
 * color from these vars (see show-widget `getCoreDesignSystem`); the sandbox
 * has to define them or text falls back to near-black and vanishes in dark mode.
 */
const THEME_TOKEN_MAP: Record<string, string> = {
  "--cb-panel-bg-primary": "--bg-card",
  "--cb-text-primary": "--text",
  "--cb-text-secondary": "--text-dim",
  "--cb-border-default": "--border",
  "--cb-accent-primary": "--accent",
};

/** Read the host's current theme values as an engine `--cb-*` map. */
function resolveThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [cb, host] of Object.entries(THEME_TOKEN_MAP)) {
    const v = cs.getPropertyValue(host).trim();
    if (v) out[cb] = v;
  }
  return out;
}

const DEFAULT_LOADING_MESSAGES = ["正在准备可视化…"];
const DEFAULT_HEIGHT = 360;
const MAX_HEIGHT = 2000;

/** Tiny resize guard: reject a streak of tiny upward nudges (avoids infinite growth loops). */
function shouldApplyHeight(next: number, prev: number, streak: { count: number; lastAt: number }): boolean {
  if (next === prev) return false;
  if (next < prev) { streak.count = 0; return true; }
  const delta = next - prev;
  const now = Date.now();
  if (delta <= 2 && now - streak.lastAt < 300) { streak.count++; if (streak.count >= 6) return false; }
  else { streak.count = 0; streak.lastAt = now; }
  return true;
}

const WidgetSandboxFrame = forwardRef<WidgetFrameHandle, {
  summary: WidgetSummary;
  isStreaming: boolean;
}>(function WidgetSandboxFrame({ summary, isStreaming }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [ready, setReady] = useState(false);
  /**
   * The payload the frame already has. The srcDoc embeds the mount-time payload,
   * so seeding this keeps the effect below from rebuilding (and re-running the
   * widget's scripts) until the payload actually changes.
   */
  const lastSentRef = useRef<string>(
    isStreaming && summary.render_mode !== "svg"
      ? sanitizeForStreaming(summary.widget_code)
      : sanitizeForIframe(summary.widget_code),
  );
  const resizeGuard = useRef({ count: 0, lastAt: 0 });
  const captureWaiters = useRef(new Map<string, (v: string | null) => void>());

  // Build initial srcDoc with the theme snapshot at mount.
  const [srcDoc] = useState(() =>
    buildSandboxHtml(summary.widget_code, isStreaming, summary.render_mode, resolveThemeVars())
  );

  // Expose capture() to the card's menu.
  useImperativeHandle(ref, () => ({
    capture: () =>
      new Promise<string | null>((resolve) => {
        const cw = iframeRef.current?.contentWindow;
        if (!ready || !cw) return resolve(null);
        const reqId = Math.random().toString(36).slice(2);
        captureWaiters.current.set(reqId, resolve);
        cw.postMessage({ type: "widget:capture", reqId }, "*");
        setTimeout(() => {
          if (captureWaiters.current.delete(reqId)) resolve(null);
        }, 4000);
      }),
  }), [ready]);

  // Handle messages from iframe
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const msg = ev.data as Record<string, unknown>;
      if (msg.type === "widget:ready") setReady(true);
      else if (msg.type === "widget:resize") {
        const next = Math.min(Math.max(Number(msg.height) || DEFAULT_HEIGHT, 20), MAX_HEIGHT);
        setHeight((prev) => (shouldApplyHeight(next, prev, resizeGuard.current) ? next : prev));
      } else if (msg.type === "widget:capture:result") {
        const reqId = String(msg.reqId ?? "");
        const done = captureWaiters.current.get(reqId);
        if (done) {
          captureWaiters.current.delete(reqId);
          done(typeof msg.dataUrl === "string" ? msg.dataUrl : null);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Live theme swap: repost --cb-* vars whenever the host toggles light/dark.
  useEffect(() => {
    if (!ready) return;
    const post = () => {
      const css = Object.entries(resolveThemeVars())
        .map(([k, v]) => `${k}: ${v};`)
        .join(" ");
      iframeRef.current?.contentWindow?.postMessage({ type: "widget:theme", css }, "*");
    };
    post();
    const mo = new MutationObserver(post);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [ready]);

  // Stream updates: post widget:update while streaming, widget:finalize when done.
  // Fires only when the payload differs from what the srcDoc already rendered.
  useEffect(() => {
    if (!ready) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (summary.render_mode === "svg") return; // SVG is static, no streaming updates

    const code = summary.widget_code;
    if (isStreaming) {
      const sanitized = sanitizeForStreaming(code);
      if (!sanitized || sanitized === lastSentRef.current) return;
      lastSentRef.current = sanitized;
      iframe.contentWindow.postMessage({ type: "widget:update", html: sanitized }, "*");
    } else {
      const sanitized = sanitizeForIframe(code);
      if (sanitized === lastSentRef.current) return;
      lastSentRef.current = sanitized;
      iframe.contentWindow.postMessage({ type: "widget:finalize", html: sanitized }, "*");
    }
  }, [ready, isStreaming, summary.widget_code, summary.render_mode]);

  // Loading messages rotation while waiting for ready
  const messages = summary.loading_messages.length > 0 ? summary.loading_messages : DEFAULT_LOADING_MESSAGES;
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    if (ready || messages.length <= 1) return;
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % messages.length), 1400);
    return () => clearInterval(t);
  }, [ready, messages]);

  return (
    <div className="relative w-full">
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-dim">
          {messages[msgIdx]}
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title={summary.title || "Interactive widget"}
        className={`w-full border-0 transition-opacity ${ready ? "opacity-100" : "opacity-0"}`}
        style={{ height, display: "block" }}
      />
    </div>
  );
});

export default WidgetSandboxFrame;
