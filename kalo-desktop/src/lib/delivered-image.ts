export type ImageSource = { kind: "local"; path: string } | { kind: "url"; url: string };

/** Markdown's URI encoder escapes filesystem spaces and Windows backslashes. */
export function markdownImageSource(source: string): string {
  if (/^(?:[a-z]:(?:[\\/]|%5c|%2f)|\/|\\\\|%5c%5c)/i.test(source)) {
    try { return decodeURIComponent(source); } catch { return source; }
  }
  return source;
}

/** File paths are resolved before URL protocols: a drive letter is not a scheme. */
export function resolveImageSource(source: string): ImageSource | null {
  if (!source || /[\u0000-\u001f]/.test(source)) return null;
  if (/^https?:\/\//i.test(source) || /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,[a-z\d+/=\s]+$/i.test(source)) {
    return { kind: "url", url: source };
  }
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.search || url.hash || url.username || url.password || url.port) return null;
      const pathname = decodeURIComponent(url.pathname);
      if (/[\u0000-\u001f]/.test(pathname)) return null;
      const path = url.hostname && url.hostname !== "localhost"
        ? `//${url.hostname}${pathname}` : pathname.replace(/^\/([a-z]:\/)/i, "$1");
      return { kind: "local", path };
    } catch { return null; }
  }
  if (/^[a-z]:[\\/]/i.test(source) || /^[/\\]{2}[^/\\]/.test(source) || source.startsWith("/")) {
    return { kind: "local", path: source.replace(/^\/([a-z]:\/)/i, "$1") };
  }
  return null;
}
