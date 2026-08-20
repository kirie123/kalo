/**
 * The `<attachments>` tag: how attachment *paths* travel to the model.
 *
 * Attachments used to be inlined as text — a pdf became tens of thousands of
 * tokens in the prompt, replayed on every later turn, and the raw text showed
 * up in the user's own bubble. Now the prompt carries only paths plus a hint
 * to read them, and the bubble renders the tag back as file chips.
 *
 * This module is the single source of truth for that format: `chat-store`
 * writes it, `UserBubble` reads it back. Paths are not escaped — Windows
 * paths cannot contain `<>:"|?*`, and parsing is done with the regexes below
 * rather than an XML parser, so `&` is fine verbatim.
 */

const HINT = "用户附加了以下文件。这里给的是路径，不是文件内容；需要时请用 read 等工具自行读取。";

/** Trailing `<attachments>…</attachments>` block, with the blank line before it. */
const TAG_RE = /\n*<attachments>\n[\s\S]*?\n<\/attachments>[ \t\r\n]*$/;
const FILE_RE = /<file path="([^"]*)"\s*\/>/g;

/** Render the tag for `paths`, or "" when there is nothing to attach. */
export function formatAttachmentTag(paths: string[]): string {
  if (paths.length === 0) return "";
  const files = paths.map((p) => `<file path="${p}" />`).join("\n");
  return `<attachments>\n${HINT}\n${files}\n</attachments>`;
}

/**
 * Split a sent message into the text the user actually typed and the attached
 * paths. Messages without the tag come back unchanged with no paths, so this
 * is safe to run over every user message in the timeline.
 */
export function parseAttachmentTag(message: string): { text: string; paths: string[] } {
  const match = TAG_RE.exec(message);
  if (!match) return { text: message, paths: [] };
  const paths: string[] = [];
  for (const m of match[0].matchAll(FILE_RE)) paths.push(m[1]);
  // A block with no <file> entries is the user's own text, not our tag.
  if (paths.length === 0) return { text: message, paths: [] };
  return { text: message.slice(0, match.index), paths };
}

/** Last path segment, for either separator. */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}
