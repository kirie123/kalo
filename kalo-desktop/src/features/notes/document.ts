/** Lossless Markdown editing helpers. No DOM, storage or IPC. */
export function splitNote(text: string): { header: string; body: string } {
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(text);
  return match ? { header: match[0], body: text.slice(match[0].length) } : { header: "", body: text };
}

export function noteTitle(text: string, fallback = "未命名笔记"): string {
  const value = /^title:[ \t]?([^\r\n]*)/m.exec(splitNote(text).header)?.[1];
  if (!value) return fallback;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  return value.replace(/^'(.*)'$/, "$1");
}

export function updateNote(text: string, change: { title?: string; body?: string }): string {
  const { header, body } = splitNote(text);
  let nextHeader = header;
  if (change.title !== undefined) {
    const title = change.title.replace(/[\r\n\t]/g, " ");
    const eol = header.includes("\r\n") ? "\r\n" : "\n";
    if (!header) nextHeader = `---${eol}title: ${title}${eol}---${eol}`;
    else if (/^title:.*$/m.test(header)) nextHeader = header.replace(/^title:[^\r\n]*/m, () => `title: ${title}`);
    else nextHeader = header.replace(/^---\r?\n/, (opening) => `${opening}title: ${title}${eol}`);
  }
  const nextBody = change.body ?? body;
  return nextHeader + (nextHeader && !nextHeader.endsWith("\n") && nextBody ? "\n" : "") + nextBody;
}

export type NoteBlock = { kind: "text"; start: number; end: number; value: string }
  | { kind: "image"; start: number; end: number; source: string; alt: string };

/** Only standalone images outside code fences become visual blocks. All other bytes stay editable. */
export function noteBlocks(body: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let cursor = 0;
  let textStart = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (!fence) {
      const image = /^ {0,3}!\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^\s]+))\)[ \t]*\r?\n?$/.exec(line);
      if (image) {
        blocks.push({ kind: "text", start: textStart, end: cursor, value: body.slice(textStart, cursor) });
        blocks.push({ kind: "image", start: cursor, end: cursor + line.length, source: image[2] || image[3], alt: image[1] });
        textStart = cursor + line.length;
      }
    }
    cursor += line.length;
  }
  blocks.push({ kind: "text", start: textStart, end: body.length, value: body.slice(textStart) });
  return blocks;
}

export function replaceNoteRange(body: string, start: number, end: number, inserted: string): string {
  return body.slice(0, start) + inserted + body.slice(end);
}

export function imageMarkdown(path: string, name: string): string {
  const encoded = encodeURI(path.replace(/\\/g, "/")).replace(/[()#?<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `![${name.replace(/[\[\]\r\n]/g, " ")}](<${encoded}>)`;
}

export function resolveNoteImage(source: string, notePath: string): string {
  if (/^(?:https?:|data:)/i.test(source)) return source;
  let decoded = source;
  try { decoded = decodeURIComponent(source); } catch { /* Let the preview report an invalid path. */ }
  if (/^(?:[a-z]:[\\/]|[/\\]|[a-z][a-z\d+.-]*:)/i.test(decoded) || !notePath) return decoded;
  const parent = notePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  const combined = `${parent}/${decoded.replace(/\\/g, "/")}`;
  const prefix = combined.startsWith("//") ? "//" : combined.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  const floor = combined.startsWith("//") ? 2 : /^[a-z]:\//i.test(combined) ? 1 : 0;
  for (const segment of combined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (segments.length > floor) segments.pop(); }
    else segments.push(segment);
  }
  return prefix + segments.join("/");
}
