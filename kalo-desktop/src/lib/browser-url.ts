/**
 * Address-bar helpers for the browser tab (pure, unit-tested).
 *
 * The rule that keeps biting: `localhost:3000` *looks* like it has a scheme
 * (`localhost:`), and handing it to an iframe verbatim resolves it against the
 * app's own origin. Only a real scheme — one that is known, or one followed by
 * `//` — may pass through untouched.
 */

const KNOWN_SCHEMES = new Set(["http", "https", "file", "about", "data", "blob", "view-source"]);

/** What the user typed → what the iframe should load. null = nothing to do. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith("//")) return `https:${text}`;
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(text);
  if (scheme && (scheme[2] === "//" || KNOWN_SCHEMES.has(scheme[1].toLowerCase()))) return text;
  return `http://${text}`;
}

/** Chip label: the host, or 浏览器 when there is nothing to show. */
export function browserTitle(url: string): string {
  try {
    return new URL(url).host || "浏览器";
  } catch {
    return "浏览器";
  }
}