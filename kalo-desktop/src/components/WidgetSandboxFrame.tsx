/**
 * WidgetSandboxFrame — renders a show_widget payload in an isolated iframe.
 *
 * P1: SVG (no scripts, streamed as-is).
 * P2: HTML+JS with the three-phase streaming renderer:
 *   - stream:  sanitizeForStreaming → postMessage widget:update (morph, no scripts)
 *   - finalize: sanitizeForIframe  → postMessage widget:finalize (full rebuild + scripts)
 *
 * Three-phase anti-flicker mechanisms (from WorkBuddy asar analysis):
 *   1. looksRenderable: skip frames with undecoded JSON escapes
 *   2. morphChildren: incremental DOM patch (CANVAS nodes skipped)
 *   3. finalize: dispose ECharts + full rebuild before re-running scripts
 *
 * The iframe sandbox is "allow-scripts" only (no allow-same-origin), so
 * localStorage/sessionStorage throw SecurityError — the engine validates this.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { WidgetSummary } from "../lib/widgets";

const CDN_ALLOWLIST = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
];

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

const DANGEROUS_TAGS = ["iframe", "object", "embed", "meta", "link", "base", "form"];

/** Strip script and dangerous tags for streaming frames; tolerate half-open HTML. */
function sanitizeForStreaming(html: string): string {
  let r = html;
  for (const tag of DANGEROUS_TAGS) {
    r = r.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    r = r.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }
  r = r.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  r = r.replace(/<script\b[^>]*\/>/gi, "");
  // Wrap unterminated <script tail in hidden span to prevent raw JS text rendering.
  const unclosed = r.match(/<script\b[^>]*>[\s\S]*$/i);
  if (unclosed) {
    const idx = r.lastIndexOf(unclosed[0]);
    r = r.slice(0, idx) + `<span style="display:none!important">${unclosed[0]}</span>`;
  }
  r = r.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  r = r.replace(/\b(href|src|action)\s*=\s*["'](javascript|data):[^"']*/gi, (_u, attr) => `${attr}=""`);
  const lastLt = r.lastIndexOf("<");
  if (lastLt > r.lastIndexOf(">")) r = r.slice(0, lastLt);
  const styleMatch = r.match(/<style\b[^>]*>(?![\s\S]*<\/style>)/i);
  if (styleMatch) r = r.slice(0, r.lastIndexOf(styleMatch[0]));
  return r.trim() === "" ? "" : r;
}

/** Keep scripts but strip dangerous tags and unsafe URL schemes for finalized frames. */
function sanitizeForIframe(html: string): string {
  let r = html;
  for (const tag of DANGEROUS_TAGS) {
    r = r.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    r = r.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }
  r = r.replace(/\b(href|action)\s*=\s*["'](javascript|data):[^"']*/gi, (_u, attr) => `${attr}=""`);
  r = r.replace(/\bsrc\s*=\s*["']javascript:[^"']*/gi, 'src=""');
  return r;
}

// The sandbox document: injects CSS vars from host theme, sets up postMessage bridge,
// and exposes renderHtml() with the three-phase anti-flicker logic.
function buildSandboxHtml(
  widgetCode: string,
  isStreaming: boolean,
  renderMode: "svg" | "html",
  themeVars: Record<string, string>,
): string {
  const cspSrc = CDN_ALLOWLIST.map((d) => `https://${d}`).join(" ");
  const themeCss = Object.entries(themeVars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${cspSrc}; style-src 'unsafe-inline'; img-src data: blob: ${cspSrc}; font-src ${cspSrc}; connect-src ${cspSrc}">
<style id="cb-theme">:root { ${themeCss} }</style>
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; color: var(--cb-text-primary); }
#root { width: 100%; min-height: 20px; overflow: visible; overflow-x: hidden; padding: 0; }
script { display: none !important; }
</style>
</head>
<body><div id="root"></div>
<script>
(function() {
  var root = document.getElementById('root');
  var lastHeight = 0;
  var pendingResize = false;

  // --- looksRenderable: skip frames with undecoded JSON escapes ---
  function looksRenderable(src, parsed) {
    if (!src) return false;
    var BACKSLASH = 92;
    var hits = 0;
    for (var i = 0; i < src.length - 1; i++) {
      if (src.charCodeAt(i) === BACKSLASH) {
        var n = src.charAt(i + 1);
        if (n === '"' || n === 'n' || n === 't' || n === 'r') {
          if (++hits >= 2) return false;
        }
      }
    }
    if (parsed.querySelector('*') !== null) return true;
    if (/<[a-zA-Z!/]/.test(src)) return false;
    return true;
  }

  // --- morphChildren: incremental DOM patch, skip CANVAS ---
  function morphNode(from, to) {
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
      from.parentNode.replaceChild(to, from); return;
    }
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return;
    }
    if (from.nodeType !== 1) return;
    if (from.nodeName === 'CANVAS') return; // GPU content — never touch
    morphElementAttributes(from, to);
    morphChildren(from, to);
  }
  function morphElementAttributes(from, to) {
    var toAttrs = Array.prototype.slice.call(to.attributes);
    for (var i = 0; i < toAttrs.length; i++) {
      if (from.getAttribute(toAttrs[i].name) !== toAttrs[i].value)
        from.setAttribute(toAttrs[i].name, toAttrs[i].value);
    }
    var fromAttrs = Array.prototype.slice.call(from.attributes);
    for (var j = 0; j < fromAttrs.length; j++) {
      if (!to.hasAttribute(fromAttrs[j].name)) from.removeAttribute(fromAttrs[j].name);
    }
  }
  function morphChildren(fromEl, toEl) {
    var toNodes = Array.prototype.slice.call(toEl.childNodes);
    for (var i = 0; i < toNodes.length; i++) {
      var toNode = toNodes[i], fromNode = fromEl.childNodes[i];
      if (!fromNode) fromEl.appendChild(toNode);
      else morphNode(fromNode, toNode);
    }
    while (fromEl.childNodes.length > toNodes.length) fromEl.removeChild(fromEl.lastChild);
  }

  // --- disposeChartsIn: ECharts dispose + canvas reset before finalize rebuild ---
  function disposeChartsIn(scope) {
    var hasE = typeof window !== 'undefined' && window.echarts;
    var getInstance = hasE && window.echarts.getInstanceByDom;
    var disposeFn = hasE && window.echarts.dispose;
    var targets = Array.prototype.slice.call(scope.querySelectorAll('*'));
    targets.push(scope);
    for (var i = 0; i < targets.length; i++) {
      try {
        if (getInstance) { var inst = getInstance(targets[i]); if (inst && inst.dispose) inst.dispose(); else if (disposeFn) disposeFn(targets[i]); }
        else if (disposeFn) disposeFn(targets[i]);
      } catch (_e) {}
    }
    var cvs = scope.querySelectorAll('canvas');
    for (var ci = 0; ci < cvs.length; ci++) { try { var cv = cvs[ci]; cv.width = cv.width; } catch (_e) {} }
  }

  function isExecutableScript(s) {
    var t = s.type || '';
    return t === '' || t === 'text/javascript' || t === 'module' || t.indexOf('javascript') !== -1;
  }

  function executeScriptsSequentially(scripts) {
    var i = 0;
    function next() {
      if (i >= scripts.length) { setTimeout(reportHeight, 50); return; }
      var s = scripts[i++];
      try {
        if (s.type === 'module') {
          var blob = new Blob([s.textContent], { type: 'text/javascript' });
          var url = URL.createObjectURL(blob);
          var m = document.createElement('script'); m.type = 'module'; m.src = url;
          m.onload = function() { URL.revokeObjectURL(url); next(); };
          m.onerror = function() { URL.revokeObjectURL(url); next(); };
          document.head.appendChild(m);
        } else {
          (0, eval)(s.textContent); next();
        }
      } catch (err) { console.error('[WidgetSandbox] script error', err); next(); }
    }
    next();
  }

  function bindInlineHandlers(scope) {
    var els = scope.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var attrs = el.getAttributeNames();
      for (var j = 0; j < attrs.length; j++) {
        var attr = attrs[j];
        if (!/^on/i.test(attr)) continue;
        var evName = attr.slice(2).toLowerCase();
        var code = el.getAttribute(attr);
        if (!evName || !code) continue;
        el.removeAttribute(attr);
        (function(element, eventName, handlerCode) {
          element.addEventListener(eventName, function(event) {
            try { new Function('event', handlerCode).call(element, event); } catch (_e) {}
          });
        })(el, evName, code);
      }
    }
  }

  // --- renderHtml: three-phase ---
  function renderHtml(html, executeScripts) {
    try {
      var temp = document.createElement('div');
      temp.innerHTML = html || '';
      bindInlineHandlers(temp);
      var allScripts = Array.prototype.slice.call(temp.querySelectorAll('script'));
      var scripts = allScripts.filter(isExecutableScript);
      scripts.forEach(function(s) { if (s.parentNode) s.parentNode.removeChild(s); });

      // Phase 1: skip undecoded/dirty streaming frames
      if (!executeScripts && !looksRenderable(html, temp)) return;

      if (executeScripts) {
        // Phase 3: finalize — dispose + full rebuild
        disposeChartsIn(root);
        while (root.firstChild) root.removeChild(root.firstChild);
        while (temp.firstChild) root.appendChild(temp.firstChild);
      } else {
        // Phase 2: streaming — incremental morph with fallback
        try { morphChildren(root, temp); }
        catch (_e) { while (root.firstChild) root.removeChild(root.firstChild); while (temp.firstChild) root.appendChild(temp.firstChild); }
      }

      if (!executeScripts) { setTimeout(reportHeight, 10); return; }
      executeScriptsSequentially(scripts);
    } catch (err) { console.error('[WidgetSandbox] render error', err); }
  }

  function reportHeight() {
    var h = Math.ceil(root.getBoundingClientRect().height);
    h = Math.min(Math.max(h, 20), 2000);
    if (h !== lastHeight && h > 0) { lastHeight = h; parent.postMessage({ type: 'widget:resize', height: h }, '*'); }
  }

  var ro = new ResizeObserver(function() {
    if (pendingResize) return;
    pendingResize = true;
    requestAnimationFrame(function() { pendingResize = false; reportHeight(); });
  });
  ro.observe(root);

  // Expose sendPrompt for interactive widgets
  window.sendPrompt = function(text) {
    if (typeof text !== 'string') text = String(text || '');
    parent.postMessage({ type: 'widget:sendMessage', text: text.slice(0, 500) }, '*');
  };

  // Intercept link clicks
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a) { e.preventDefault(); e.stopPropagation(); var href = a.href; if (href && !/^(javascript|data):/i.test(href)) parent.postMessage({ type: 'widget:link', href: href }, '*'); }
  }, true);

  // --- captureToPng: rasterize #root to a PNG data URL ---
  // Serialize the live DOM into an SVG <foreignObject>, inlining every <style>
  // so theme colors survive, and swapping each <canvas> (ECharts) for an <img>
  // of its pixels — foreignObject renders canvas elements blank otherwise.
  function captureToPng(reqId) {
    function reply(dataUrl, error) {
      parent.postMessage({ type: 'widget:capture:result', reqId: reqId, dataUrl: dataUrl || null, error: error || null }, '*');
    }
    try {
      var rect = root.getBoundingClientRect();
      var w = Math.max(1, Math.ceil(rect.width));
      var h = Math.max(1, Math.ceil(rect.height));
      var clone = root.cloneNode(true);
      var srcCanvas = root.querySelectorAll('canvas');
      var dstCanvas = clone.querySelectorAll('canvas');
      for (var i = 0; i < srcCanvas.length && i < dstCanvas.length; i++) {
        try {
          var img = document.createElement('img');
          img.src = srcCanvas[i].toDataURL('image/png');
          img.width = srcCanvas[i].width; img.height = srcCanvas[i].height;
          img.style.cssText = dstCanvas[i].style.cssText;
          if (dstCanvas[i].parentNode) dstCanvas[i].parentNode.replaceChild(img, dstCanvas[i]);
        } catch (_e) {}
      }
      var styleText = '';
      var styleTags = document.querySelectorAll('style');
      for (var s = 0; s < styleTags.length; s++) styleText += styleTags[s].textContent + '\\n';
      var xml = new XMLSerializer().serializeToString(clone);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">' +
        '<style>' + styleText + '</style>' + xml + '</div></foreignObject></svg>';
      var svgImg = new Image();
      svgImg.onload = function() {
        try {
          var scale = Math.min(2, (window.devicePixelRatio || 1));
          var cv = document.createElement('canvas');
          cv.width = w * scale; cv.height = h * scale;
          var ctx = cv.getContext('2d');
          var bg = getComputedStyle(document.documentElement).getPropertyValue('--cb-panel-bg-primary').trim();
          ctx.fillStyle = bg || '#ffffff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.scale(scale, scale);
          ctx.drawImage(svgImg, 0, 0);
          reply(cv.toDataURL('image/png'), null);
        } catch (err) { reply(null, String(err)); }
      };
      svgImg.onerror = function() { reply(null, 'svg-load-failed'); };
      svgImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch (err) { reply(null, String(err)); }
  }

  window.addEventListener('message', function(ev) {
    if (!ev.data || typeof ev.data !== 'object') return;
    var msg = ev.data;
    if (msg.type === 'widget:update') renderHtml(msg.html, false);
    else if (msg.type === 'widget:finalize') renderHtml(msg.html, true);
    else if (msg.type === 'widget:theme') {
      var el = document.getElementById('cb-theme');
      if (el && typeof msg.css === 'string') el.textContent = ':root { ' + msg.css + ' }';
    }
    else if (msg.type === 'widget:capture') captureToPng(msg.reqId);
  });

  // Signal ready and inject initial content
  parent.postMessage({ type: 'widget:ready' }, '*');
  ${renderMode === "svg"
    ? `root.innerHTML = ${JSON.stringify(sanitizeForIframe(widgetCode))};`
    : isStreaming
      ? `renderHtml(${JSON.stringify(sanitizeForStreaming(widgetCode))}, false);`
      : `renderHtml(${JSON.stringify(sanitizeForIframe(widgetCode))}, true);`
  }
  setTimeout(reportHeight, 50);
})();
</script>
</body></html>`;
}

const DEFAULT_LOADING_MESSAGES = ["正在准备可视化…"];
const HANDSHAKE_INTERVAL_MS = 250;
const BOOTSTRAP_TIMEOUT_MS = 5000;
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
  const lastSentRef = useRef<string>("");
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

  // Stream updates: post widget:update while streaming, widget:finalize when done
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
