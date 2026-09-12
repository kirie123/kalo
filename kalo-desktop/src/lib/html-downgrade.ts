/**
 * Whitelisted inline HTML in model output, downgraded to markdown
 * (doc/2026-09-12-对话区svg渲染.md).
 *
 * Models sometimes reach for `<h3>`, `<br>` or `<table>` mid-answer. Today
 * those show up as literal source, because the transcript deliberately does
 * not enable `rehype-raw` — raw HTML from tool output or a fetched page must
 * never execute in the webview.
 *
 * So instead of *rendering* HTML we *rewrite* it: `<b>x</b>` becomes `**x**`
 * and remark takes it from there. Nothing is injected as HTML, so the attack
 * surface stays exactly where it was; tags outside the whitelist are left as
 * visible source rather than silently swallowed.
 *
 * Code is off limits (`mapOutsideCode`): an ```html fence documenting a tag
 * must keep showing that tag.
 */

import { mapOutsideCode } from "./md-scan";

/** Elements whose content is markup, never prose: dropped whole. */
const DROP_WITH_CONTENT = ["script", "style", "iframe", "object", "embed", "template", "noscript"];

/** Rewrite whitelisted HTML in `text` as markdown. */
export function htmlToMarkdown(text: string): string {
  if (!/<[a-z!/]/i.test(text)) return text;
  return mapOutsideCode(text, downgrade);
}

function downgrade(slice: string): string {
  if (!/<[a-z!/]/i.test(slice)) return slice;
  let out = slice;

  for (const tag of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
  }
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // Pre/code first: their content must survive the inline rules untouched.
  out = out.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code: string) =>
    fence(decodeEntities(code)),
  );
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => fence(decodeEntities(stripTags(code))));
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => `\`${decodeEntities(stripTags(code))}\``);

  out = out.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, body: string) => tableToMarkdown(body));

  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
    const text = inline(inner).trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
  });

  // Lists and quotes nest, so they are rewritten innermost-first: a lazy
  // outer match would stop at the *inner* closing tag and strip the wrong one.
  out = replaceInnermost(out, ["blockquote"], (_tag, inner) => {
    const body = downgrade(inner).trim();
    return `\n\n${body.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
  });
  out = replaceInnermost(out, ["ul", "ol"], (tag, inner) => list(inner, tag.toLowerCase() === "ol"));

  out = out.replace(/<br\s*\/?>/gi, "  \n");
  out = out.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  out = out.replace(/<\/p\s*>/gi, "\n\n").replace(/<p\b[^>]*>/gi, "\n\n");
  out = out.replace(/<\/(div|section|article|header|footer|main|figure|figcaption)\s*>/gi, "\n\n");
  out = out.replace(/<(div|section|article|header|footer|main|figure|figcaption)\b[^>]*>/gi, "\n\n");

  out = inline(out);
  // Paragraph breaks introduced above must not turn into blank-line spam.
  return out.replace(/\n{3,}/g, "\n\n");
}

/** Inline-level rules, safe to apply to a fragment. */
function inline(text: string): string {
  let out = text;
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => wrap(inner, "**"));
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => wrap(inner, "*"));
  out = out.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => wrap(inner, "~~"));
  out = out.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (match, href: string, inner: string) => {
      const label = stripTags(inner).trim();
      if (!isSafeUrl(href)) return label || match;
      return label ? `[${label}](${href.trim()})` : `<${href.trim()}>`;
    },
  );
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    return isSafeUrl(src) ? `![${alt}](${src.trim()})` : "";
  });
  // Presentational wrappers with no markdown equivalent: keep the words.
  out = out.replace(/<\/?(span|font|u|mark|small|big|sub|sup|kbd|abbr|cite|time|q|label)\b[^>]*>/gi, "");
  return out;
}

/**
 * Rewrite elements of `tags` from the inside out, so nesting survives.
 * Terminates because a rendered chunk no longer contains those tags.
 */
function replaceInnermost(text: string, tags: string[], render: (tag: string, inner: string) => string): string {
  const alt = tags.join("|");
  const innermost = new RegExp(`<(${alt})\\b[^>]*>((?:(?!<(?:${alt})\\b)[\\s\\S])*?)</\\1\\s*>`, "i");
  let out = text;
  for (let guard = 0; guard < 100; guard++) {
    const match = innermost.exec(out);
    if (!match) break;
    out = out.slice(0, match.index) + render(match[1], match[2]) + out.slice(match.index + match[0].length);
  }
  return out;
}

function wrap(inner: string, marker: string): string {
  const body = inline(inner).trim();
  return body ? `${marker}${body}${marker}` : "";
}

function list(inner: string, ordered: boolean): string {
  const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)(?:<\/li\s*>|(?=<li\b)|$)/gi)];
  if (items.length === 0) return "\n\n";
  const lines = items.map((m, i) => {
    // Nested lists are handled by the recursive call, then re-indented.
    const body = downgrade(m[1]).trim().replace(/\n/g, "\n  ");
    return `${ordered ? `${i + 1}.` : "-"} ${body}`;
  });
  return `\n\n${lines.join("\n")}\n\n`;
}

function tableToMarkdown(body: string): string {
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
    [...row[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((cell) =>
      inline(stripTags(cell[2])).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(),
    ),
  );
  if (rows.length === 0 || rows[0].length === 0) return "\n\n";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill("")];
  const head = pad(rows[0]);
  const rest = rows.slice(1).map(pad);
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rest.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

function fence(code: string): string {
  return `\n\n\`\`\`\n${code.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function isSafeUrl(url: string): boolean {
  const value = url.trim();
  if (value === "") return false;
  if (/^(#|\/|\.\.?\/)/.test(value)) return true;
  return /^(https?:|mailto:|data:image\/(png|jpe?g|gif|webp);)/i.test(value);
}

/** Only the entities that would otherwise survive into a code span. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
