import hljs from "highlight.js";

/**
 * Syntax highlighting with a cache, shared by every code view (transcript code
 * blocks, SVG source, whole-file preview).
 *
 * A streaming message re-renders ~20 times a second, and `highlightAuto` (used
 * for fenced blocks without a language) is by far the most expensive step in
 * that path — without a cache it runs on every frame for every code block
 * already on screen.
 */
const HL_CACHE = new Map<string, string>();
const HL_CACHE_MAX = 200;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlight(code: string, lang?: string): string {
  const key = `${lang ?? ""}${code}`;
  const cached = HL_CACHE.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
  } catch {
    html = escapeHtml(code);
  }
  // Crude FIFO trim: streaming produces a new key per frame, so the map must
  // not be allowed to grow without bound.
  if (HL_CACHE.size >= HL_CACHE_MAX) {
    const oldest = HL_CACHE.keys().next().value;
    if (oldest !== undefined) HL_CACHE.delete(oldest);
  }
  HL_CACHE.set(key, html);
  return html;
}
