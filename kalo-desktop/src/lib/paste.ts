/** Pure clipboard decisions; DOM and desktop IPC live in the intake adapter. */
export const LARGE_PASTE_LENGTH = 6000;

export function shouldAttachPastedText(text: string, hasFiles = false): boolean {
  return !hasFiles && text.length >= LARGE_PASTE_LENGTH;
}

/** Only explicit local file URIs, never ordinary pasted text or web URLs. */
export function clipboardUriPaths(uriList: string): string[] {
  const paths: string[] = [];
  for (const line of uriList.split(/\r?\n/)) {
    if (!line.startsWith("file://")) continue;
    try {
      const uri = new URL(line);
      let path = decodeURIComponent(uri.pathname);
      if (uri.hostname && uri.hostname !== "localhost") path = `//${uri.hostname}${path}`;
      else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      if (!paths.includes(path)) paths.push(path);
    } catch { /* Ignore malformed URIs, retaining any valid files. */ }
  }
  return paths;
}

export function attachmentPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase() : normalized;
}
