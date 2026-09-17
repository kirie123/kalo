/**
 * File preview of an HTML document, rendered in a sandboxed frame
 * (doc/2026-09-17-html预览渲染.md).
 *
 * Two things have to happen before a local document can be shown inside an
 * iframe, and neither is about layout:
 *
 *   1. **Its assets are unreachable.** `<link rel=stylesheet href="../assets/doc.css">`
 *      resolves against a webview origin that has no filesystem behind it, so
 *      the document would render as unstyled HTML. We find those references,
 *      the caller reads the files through the app's own IPC, and we splice the
 *      contents back in as `<style>` / `<script>` / data URL.
 *   2. **Its code must not run by default.** The frame is sandboxed without
 *      same-origin, and in the default mode the document's own scripts,
 *      `on*` handlers and `javascript:` URLs are removed outright — see
 *      `doc/2026-09-12-对话区svg渲染.md` for why this codebase does not let
 *      arbitrary HTML execute.
 *
 * Everything here is pure string work: the caller does the reading. That keeps
 * this module IPC-free (node-testable) and keeps every `invoke` in one place.
 */

/** Kinds of in-document reference we inline. */
export type AssetKind = "style" | "script" | "image";

/** One reference to a local file, with the byte range it occupies. */
export interface LocalAsset {
  kind: AssetKind;
  /** Value as written in the document (kept for error messages). */
  url: string;
  /** Absolute path, resolved against the document's own directory. */
  path: string;
  /** `[start, end)` of the whole element in the source. */
  start: number;
  end: number;
  /** `media` attribute of a `<link>`, carried over to the inlined `<style>`. */
  media?: string;
}

/** Cap on inlined references: a pathological document must not fan out into hundreds of reads. */
export const MAX_ASSETS = 32;

/**
 * Handed to the app from inside the frame (scripts-enabled mode only): the
 * document cannot reach the parent's window, but it can post a message.
 */
export interface BridgeMessage {
  /** Absolute path of a document link the reader clicked. */
  kaloOpen?: string;
  /** Forwarded key; Escape has to escape the sandbox or fullscreen traps the reader. */
  kaloKey?: string;
}

/**
 * The only script this module ever produces. Injected after the document's own
 * scripts have been dealt with, so it is never stripped by accident.
 */
export const BRIDGE_SCRIPT = `(function () {
  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-kalo-doc]") : null;
    if (!el) return;
    ev.preventDefault();
    parent.postMessage({ kaloOpen: el.getAttribute("data-kalo-doc") }, "*");
  }, true);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") parent.postMessage({ kaloKey: "Escape" }, "*");
  }, true);
})();`;

/** Build the document that goes into the frame. */
export function renderDocHtml(
  html: string,
  docPath: string,
  opts: { assets: LocalAsset[]; inline: Map<string, string>; allowScripts: boolean },
): string {
  let out = applyAssets(html, opts.assets, opts.inline, opts.allowScripts);
  out = opts.allowScripts ? stripRemoteScripts(out) : stripAuthorScripts(out);
  out = rewriteLinks(out, docPath);
  // Last, and after the script policy ran: the bridge is ours, not the document's.
  return opts.allowScripts ? injectBeforeBody(out, BRIDGE_SCRIPT) : out;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directory of a path, tolerating both separators; "" when it has none. */
export function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : norm.slice(0, i);
}

/**
 * Join a relative reference onto a directory, collapsing `.` / `..`.
 * Absolute references (`/x`, `C:/x`) replace the base entirely. Always answers
 * with forward slashes — the app's own convention for paths (see `files.rs`).
 */
export function joinPath(dir: string, rel: string): string {
  const abs = /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel);
  // The leading "" segment of a posix-style base is its root marker, and
  // filter(Boolean) below throws it away — so remember the root separately.
  const rooted = !/^[A-Za-z]:/.test(rel) && (abs ? /^[\\/]/.test(rel) : /^\//.test(dir));
  const out = abs ? [] : dir.replace(/\\/g, "/").split("/").filter(Boolean);
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Never climb past a root: `../..` from `C:/x` is `C:/`.
      if (out.length > 0 && !/^[A-Za-z]:$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (/^[A-Za-z]:$/.test(joined)) return `${joined}/`;
  if (joined === "") return rooted ? "/" : "";
  return rooted ? `/${joined}` : joined;
}

/**
 * Absolute path for a locally-loadable reference, or null when the reference
 * is not a local file (`http(s)`, `data:`, protocol-relative, `#fragment`).
 * Query and fragment are dropped: a data URL cannot carry them anyway.
 */
export function resolveLocalPath(url: string, docPath: string): string | null {
  const raw = url.trim();
  if (raw === "" || raw.startsWith("#")) return null;
  const bare = raw.split("#")[0].split("?")[0];

  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) {
    if (!/^file:\/\//i.test(bare)) return null;
    // file:///C:/x → C:/x ; file:///home/x → /home/x
    const rest = bare.replace(/^file:\/\//i, "");
    return /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
  }
  if (bare.startsWith("//")) return null; // protocol-relative: remote
  if (bare === "") return null;
  return joinPath(dirOf(docPath), bare);
}

// ---------------------------------------------------------------------------
// Finding references
// ---------------------------------------------------------------------------

interface ElementSpan {
  /** `[start, end)` covering the whole element. */
  start: number;
  end: number;
  /** Opening tag text only. */
  tag: string;
  /** Lower-cased attribute names. */
  attrs: Record<string, string>;
}

/** Attributes in any quoting style, unquoted values included. */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/**
 * Find elements by name, correctly pairing `<script>` with its `</script>` so
 * the range covers the whole element (needed to replace or drop it wholesale).
 * `<script src=x/>` is honoured as a void element: otherwise a lazy match
 * would swallow everything up to some unrelated later `</script>`.
 */
function scanElements(html: string, name: string): ElementSpan[] {
  const out: ElementSpan[] = [];
  const open = new RegExp(`<${name}(?=[\\s/>])`, "gi");
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const tagEnd = html.indexOf(">", m.index);
    if (tagEnd === -1) break;
    const tag = html.slice(m.index, tagEnd + 1);
    let end = tagEnd + 1;
    if (!/\/\s*>$/.test(tag)) {
      const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(end));
      end = close ? end + close.index + close[0].length : end;
    }
    out.push({ start: m.index, end, tag, attrs: parseAttrs(tag) });
    open.lastIndex = end;
  }
  return out;
}

/**
 * Local files an HTML document points at, in source order. Remote, `data:` and
 * fragment references are left out on purpose: they load (or not) on their own,
 * nothing to inline.
 */
export function collectLocalAssets(html: string, docPath: string): LocalAsset[] {
  const found: LocalAsset[] = [];

  for (const el of scanElements(html, "link")) {
    const rel = (el.attrs.rel ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const href = el.attrs.href ?? "";
    const path = resolveLocalPath(href, docPath);
    if (path) found.push({ kind: "style", url: href, path, start: el.start, end: el.end, media: el.attrs.media });
  }

  for (const el of scanElements(html, "script")) {
    const path = resolveLocalPath(el.attrs.src ?? "", docPath);
    if (path) found.push({ kind: "script", url: el.attrs.src ?? "", path, start: el.start, end: el.end });
  }

  for (const el of scanElements(html, "img")) {
    const path = resolveLocalPath(el.attrs.src ?? "", docPath);
    if (path) found.push({ kind: "image", url: el.attrs.src ?? "", path, start: el.start, end: el.end });
  }

  found.sort((a, b) => a.start - b.start);
  return found.slice(0, MAX_ASSETS);
}

/** References that stayed unresolved, for the "could not inline" notice. */
export function unresolvedAssets(assets: LocalAsset[], inline: Map<string, string>): LocalAsset[] {
  return assets.filter((a) => !inline.has(a.path));
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Replace byte ranges; `edits` may be unordered and must not overlap. */
function splice(html: string, edits: { start: number; end: number; text: string }[]): string {
  let out = html;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** A literal `</script>` inside JS/CSS would close the host element early. */
function escapeCloser(code: string, tag: string): string {
  return code.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

/**
 * Splice inlined contents back into the document. References missing from
 * `inline` (unreadable file, over the size cap) keep their original markup
 * rather than silently disappearing — an un-inlined stylesheet has to be
 * visible to the reader, not just to the console.
 */
export function applyAssets(
  html: string,
  assets: LocalAsset[],
  inline: Map<string, string>,
  allowScripts: boolean,
): string {
  const edits: { start: number; end: number; text: string }[] = [];

  for (const asset of assets) {
    const source = html.slice(asset.start, asset.end);
    if (asset.kind === "script" && !allowScripts) {
      // No script runs in this mode, ours included: drop it whole.
      edits.push({ start: asset.start, end: asset.end, text: "" });
      continue;
    }
    const payload = inline.get(asset.path);
    if (payload === undefined) continue;

    if (asset.kind === "style") {
      const media = asset.media ? ` media="${asset.media.replace(/"/g, "&quot;")}"` : "";
      edits.push({
        start: asset.start,
        end: asset.end,
        text: `<style${media}>${escapeCloser(payload, "style")}</style>`,
      });
    } else if (asset.kind === "script") {
      edits.push({ start: asset.start, end: asset.end, text: `<script>${escapeCloser(payload, "script")}</script>` });
    } else {
      // Keep the tag's other attributes (alt, class, sizes…) and swap the URL.
      const text = source.replace(
        /(\bsrc\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i,
        (_m, prefix: string, quoted: string) => {
          const quote = quoted[0] === '"' ? '"' : quoted[0] === "'" ? "'" : "";
          return `${prefix}${quote}${payload}${quote}`;
        },
      );
      edits.push({ start: asset.start, end: asset.end, text });
    }
  }

  return splice(html, edits);
}

/** Drop elements by name; `keepIf` spares the ones it accepts. */
function removeElements(html: string, name: string, keepIf?: (attrs: Record<string, string>) => boolean): string {
  const edits = scanElements(html, name)
    .filter((el) => !(keepIf?.(el.attrs) ?? false))
    .map((el) => ({ start: el.start, end: el.end, text: "" }));
  return splice(html, edits);
}

/**
 * Text ranges where `<…>` is not markup: `<script>` and `<style>` bodies.
 * A regex over a document will otherwise rewrite link-looking strings inside
 * JS source, and strip `on*` patterns out of sample code.
 */
function contentRanges(html: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const name of ["script", "style"]) {
    for (const el of scanElements(html, name)) {
      const open = el.tag.length;
      ranges.push([el.start + open, Math.max(el.start + open, el.end)]);
    }
  }
  return ranges;
}

function inRanges(index: number, ranges: [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Apply `fn` to every opening tag, leaving text and script/style bodies alone. */
function rewriteTags(html: string, fn: (tag: string) => string): string {
  const ranges = contentRanges(html);
  const edits: { start: number; end: number; text: string }[] = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    if (inRanges(m.index, ranges)) continue;
    const next = fn(m[0]);
    if (next !== m[0]) edits.push({ start: m.index, end: m.index + m[0].length, text: next });
  }
  return splice(html, edits);
}

const URL_ATTRS = /\b(href|src|action|formaction|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

function isScriptUrl(value: string): boolean {
  // Browsers ignore control characters and whitespace when reading the scheme.
  const flat = value.trim().toLowerCase().replace(/[\u0000-\u0020\u007f]/g, "");
  return flat.startsWith("javascript:") || flat.startsWith("vbscript:");
}

/**
 * Default mode: nothing in the document executes. Scripts go away entirely
 * (the sandbox has no `allow-scripts` either — belt and braces), event-handler
 * attributes and `javascript:` URLs are removed so enabling the bridge later
 * cannot turn a dormant handler into a live one.
 */
export function stripAuthorScripts(html: string): string {
  let out = removeElements(html, "script");
  // A meta refresh would navigate the frame away from the document.
  out = removeElements(out, "meta", (attrs) => (attrs["http-equiv"] ?? "").toLowerCase() !== "refresh");
  return rewriteTags(out, (tag) => {
    let next = tag.replace(/\son[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    next = next.replace(/\son[a-z][\w:-]*(?=[\s/>])/gi, ""); // bare `<img onerror>`
    return next.replace(URL_ATTRS, (match, name: string, dq?: string, sq?: string, bare?: string) =>
      isScriptUrl(dq ?? sq ?? bare ?? "") ? `${name}="#"` : match,
    );
  });
}

/**
 * Scripts-enabled mode: the document's own inline scripts may run, but a
 * remote `<script src="https://…">` stays out — the reader asked to run this
 * file, not whatever a CDN serves today.
 */
export function stripRemoteScripts(html: string): string {
  return removeElements(html, "script", (attrs) => {
    const src = (attrs.src ?? "").trim();
    return src === "" || (!/^https?:/i.test(src) && !src.startsWith("//"));
  });
}

/**
 * Point in-document links at the app instead of at a URL that cannot resolve.
 *
 * Local file links become inert `href="#"` + `data-kalo-doc` (the bridge turns
 * them into an in-app open, or nothing at all when scripts are off — either
 * way the frame never navigates somewhere broken). Remote links go to a new
 * tab, which the sandbox refuses: a link must not replace the document the
 * reader is looking at.
 */
export function rewriteLinks(html: string, docPath: string): string {
  return rewriteTags(html, (tag) => {
    if (!/^<a[\s>]/i.test(tag)) return tag;
    const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
    if (!match) return tag;
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const trimmed = href.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return tag;

    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    if ((hasScheme && !/^file:/i.test(trimmed)) || trimmed.startsWith("//")) {
      let next = tag;
      if (!/\btarget\s*=/i.test(next)) next = addAttr(next, "target", "_blank");
      if (!/\brel\s*=/i.test(next)) next = addAttr(next, "rel", "noopener noreferrer");
      return next;
    }

    const path = resolveLocalPath(trimmed, docPath);
    if (!path) return tag;
    let next = tag.replace(match[0], `href="#"`);
    return addAttr(next, "data-kalo-doc", path);
  });
}

function addAttr(tag: string, name: string, value: string): string {
  const attr = ` ${name}="${value.replace(/"/g, "&quot;")}"`;
  return tag.replace(/\s*\/?>$/, (tail) => `${attr}${tail}`);
}

/** Append a script body just before `</body>`, or at the end when there is none. */
export function injectBeforeBody(html: string, code: string): string {
  const tag = `<script>${escapeCloser(code, "script")}</script>`;
  const close = /<\/body\s*>/i.exec(html);
  if (!close) return html + tag;
  return html.slice(0, close.index) + tag + html.slice(close.index);
}
