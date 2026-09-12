/**
 * SVG rendering support for the transcript (doc/2026-09-12-对话区svg渲染.md).
 *
 * Two pure steps, both usable from node tests:
 *   1. `splitSvgSegments` — carve `<svg>…</svg>` out of a markdown source so
 *      the renderer can hand those spans to a real SVG view instead of
 *      printing XML. Fenced/inline code is skipped: an ```html block showing
 *      SVG source must stay source.
 *   2. `sanitizeSvg` — scrub a span before it is injected via innerHTML, and
 *      namespace its ids so two figures in one message cannot steal each
 *      other's gradients.
 *
 * Regex-based on purpose: this module must stay DOM-free (lib layer), and the
 * threat model is "model output rendered in our own webview", not "hostile
 * page trying to break out of a sanitizer".
 */

import { plainRanges } from "./md-scan";

export type MarkdownSegment =
  | { type: "markdown"; text: string }
  | {
      type: "svg";
      /** Raw `<svg …>…</svg>` source (or the partial head while streaming). */
      source: string;
      /** False while the closing tag has not arrived yet. */
      complete: boolean;
    };

/** Sources above this are treated as unrenderable and fall back to code. */
export const MAX_SVG_SOURCE = 256 * 1024;

/**
 * Split markdown into plain segments and top-level SVG spans.
 *
 * Returns a single markdown segment when the text has no SVG, so the common
 * path renders exactly like before.
 */
export function splitSvgSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let plainStart = 0;

  const pushPlain = (end: number) => {
    if (end > plainStart) segments.push({ type: "markdown", text: text.slice(plainStart, end) });
  };

  // Only starts outside code count; the span itself may run past the range
  // (a figure containing a stray backtick is still one figure).
  for (const range of plainRanges(text)) {
    let i = Math.max(range.start, plainStart);
    while (i < range.end) {
      if (!startsSvgTag(text, i)) {
        i += 1;
        continue;
      }
      const span = readSvgSpan(text, i);
      pushPlain(i);
      segments.push({ type: "svg", source: span.source, complete: span.complete });
      i = span.end;
      plainStart = i;
    }
  }
  pushPlain(text.length);
  return segments.length > 0 ? segments : [{ type: "markdown", text }];
}

function startsSvgTag(text: string, i: number): boolean {
  if (text[i] !== "<") return false;
  if (!/^<svg/i.test(text.slice(i, i + 4))) return false;
  const after = text[i + 4];
  return after === undefined || after === ">" || after === "/" || /\s/.test(after);
}

/** Read one `<svg>…</svg>` span from `i`, counting nested roots. */
function readSvgSpan(text: string, i: number): { source: string; complete: boolean; end: number } {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    if (startsSvgTag(text, j)) {
      const tagEnd = text.indexOf(">", j);
      if (tagEnd === -1) break;
      // `<svg …/>` opens and closes in one go.
      if (text[tagEnd - 1] !== "/") depth += 1;
      j = tagEnd + 1;
      if (depth === 0) return { source: text.slice(i, j), complete: true, end: j };
      continue;
    }
    if (/^<\/svg\s*>/i.test(text.slice(j, j + 16))) {
      const tagEnd = text.indexOf(">", j);
      if (tagEnd === -1) break;
      depth -= 1;
      j = tagEnd + 1;
      if (depth <= 0) return { source: text.slice(i, j), complete: true, end: j };
      continue;
    }
    j += 1;
  }
  // Unterminated: everything left belongs to the (still streaming) figure.
  return { source: text.slice(i), complete: false, end: text.length };
}

/**
 * Scrub an SVG span for innerHTML injection and namespace its ids.
 * Returns null when the source cannot be rendered safely (too large, or no
 * root tag) — callers fall back to showing the source as code.
 */
export function sanitizeSvg(source: string): string | null {
  if (source.length > MAX_SVG_SOURCE) return null;
  if (!/<svg[\s>/]/i.test(source)) return null;

  let svg = source;
  // Prolog / doctype / entity declarations (entity expansion, external refs).
  // A doctype may carry an internal subset (`[ … ]`) that itself contains `>`.
  svg = svg.replace(/<\?[\s\S]*?\?>/g, "");
  svg = svg.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "");
  svg = svg.replace(/<![^>]*>/g, "");
  // Comments can hide a "<script" that only appears after other rewrites.
  svg = svg.replace(/<!--[\s\S]*?-->/g, "");
  // Executable or HTML-reintroducing elements, closing tag optional so a
  // truncated `<script>` cannot survive as a bare opening tag.
  svg = stripElement(svg, "script");
  svg = stripElement(svg, "foreignObject");
  svg = stripElement(svg, "iframe");
  svg = stripElement(svg, "handler");
  // Event handlers in any quoting style.
  svg = svg.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  svg = svg.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  svg = svg.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // Links: keep in-document fragments and inline images, drop everything else
  // (javascript:, data: of other types, and network fetches).
  svg = svg.replace(/\s(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _q, dq, sq) => {
    const value = (dq ?? sq ?? "").trim();
    return isSafeRef(value) ? match : "";
  });
  svg = svg.replace(/\s(?:xlink:)?href\s*=\s*([^\s>"']+)/gi, (match, value: string) =>
    isSafeRef(value.trim()) ? match : "",
  );
  // CSS escape hatches inside <style> or style="".
  svg = svg.replace(/@import/gi, "");
  svg = svg.replace(/javascript:/gi, "");

  const prefix = idPrefix(source);
  svg = namespaceIds(svg, prefix);

  // Anything before the root tag is prolog leftovers, never content.
  const rootAt = svg.search(/<svg[\s>/]/i);
  if (rootAt === -1) return null;
  return svg.slice(rootAt).trim();
}

function isSafeRef(value: string): boolean {
  if (value.startsWith("#")) return true;
  return /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(value);
}

/** Remove `<tag …>…</tag>`, and a dangling `<tag …>` with no closing tag. */
function stripElement(svg: string, tag: string): string {
  const paired = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi");
  const open = new RegExp(`<${tag}\\b[^>]*>?`, "gi");
  return svg.replace(paired, "").replace(open, "");
}

/**
 * Rewrite `id="x"` and its references to `<prefix>-x`, so several figures in
 * one message keep their own gradients, filters and clip paths.
 */
export function namespaceIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  for (const m of svg.matchAll(/\sid\s*=\s*"([^"]+)"/gi)) ids.add(m[1]);
  for (const m of svg.matchAll(/\sid\s*=\s*'([^']+)'/gi)) ids.add(m[1]);
  if (ids.size === 0) return svg;

  let out = svg;
  for (const id of ids) {
    const esc = escapeRegExp(id);
    const next = `${prefix}-${id}`;
    out = out.replace(new RegExp(`(\\sid\\s*=\\s*["'])${esc}(["'])`, "g"), `$1${next}$2`);
    out = out.replace(new RegExp(`url\\(\\s*#${esc}\\s*\\)`, "g"), `url(#${next})`);
    out = out.replace(new RegExp(`((?:xlink:)?href\\s*=\\s*["'])#${esc}(["'])`, "g"), `$1#${next}$2`);
    out = out.replace(new RegExp(`(begin\\s*=\\s*["'])${esc}\\.`, "g"), `$1${next}.`);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Stable per-figure prefix derived from the source itself: a counter or a
 * random value would change on every streaming frame and make React throw the
 * rendered figure away each time.
 */
export function idPrefix(source: string): string {
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `s${(h >>> 0).toString(36)}`;
}

/**
 * Does the figure paint its own full-bleed background?
 *
 * Decides the canvas backdrop: a figure that already fills its viewBox (dark
 * cards are the common case) should sit on the theme's own surface, while a
 * transparent one needs a light backdrop or its dark strokes vanish in dark
 * mode. Cheap structural check — a rect at the origin covering ~the whole
 * viewBox with a real fill, or a background declared on the root element.
 */
export function hasOwnBackdrop(source: string): boolean {
  const root = /<svg\b[^>]*>/i.exec(source)?.[0] ?? "";
  if (/\bstyle\s*=\s*["'][^"']*background[^"']*["']/i.test(root)) return true;

  const box = viewBoxOf(root);
  if (!box) return false;
  for (const tag of source.matchAll(/<rect\b[^>]*>/gi)) {
    const rect = tag[0];
    const x = numAttr(rect, "x") ?? 0;
    const y = numAttr(rect, "y") ?? 0;
    const w = numAttr(rect, "width");
    const h = numAttr(rect, "height");
    if (w === null || h === null) continue;
    const fill = /\bfill\s*=\s*["']([^"']*)["']/i.exec(rect)?.[1]?.trim().toLowerCase() ?? "";
    if (fill === "none" || fill === "transparent") continue;
    const covers = x <= box.w * 0.02 && y <= box.h * 0.02 && w >= box.w * 0.96 && h >= box.h * 0.96;
    if (covers) return true;
  }
  return false;
}

/** Drawing box of the root tag, from viewBox or from width/height. */
function viewBoxOf(root: string): { w: number; h: number } | null {
  const vb = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1];
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }
  const w = numAttr(root, "width");
  const h = numAttr(root, "height");
  return w !== null && h !== null && w > 0 && h > 0 ? { w, h } : null;
}

/** Numeric attribute value, ignoring units (`140px` counts as 140). */
function numAttr(tag: string, name: string): number | null {
  const raw = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Default file name for "save as", derived from a `<title>` when present. */
export function suggestSvgFileName(source: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1]?.trim();
  const slug = (title ?? "")
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "")
    .slice(0, 40);
  return `${slug || "figure"}.svg`;
}
