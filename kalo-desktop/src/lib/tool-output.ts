/**
 * Head/tail capping for tool output rendered in the timeline.
 *
 * Tool results reach the desktop unbounded: a build log, a stack trace, a
 * `cat` of a large file. Every character lands in a `<pre>` that stays in the
 * DOM for the life of the session, so an uncapped multi-megabyte result costs
 * layout and memory on every scroll and relayout of a long session.
 *
 * The cap keeps the head and the tail — the first lines of a log and, more
 * often what actually matters, its ending — and reports what was dropped so
 * the UI can offer an explicit "show all" (see ToolCallGroup's OutputPre).
 */

export const TOOL_OUTPUT_MAX_CHARS = 20_000;
export const TOOL_OUTPUT_MAX_LINES = 400;

export interface CappedToolOutput {
  /** Text to render: unchanged when within the limits. */
  text: string;
  truncated: boolean;
  hiddenChars: number;
  hiddenLines: number;
}

export interface ToolOutputLimits {
  maxChars?: number;
  maxLines?: number;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Keep the first whole lines inside `maxChars`; falls back to a raw cut. */
function snapHead(slice: string, maxChars: number): string {
  const clipped = slice.slice(0, maxChars);
  const nl = clipped.lastIndexOf("\n");
  return nl <= 0 ? clipped : clipped.slice(0, nl);
}

/** Keep the last whole lines inside `maxChars`; falls back to a raw cut. */
function snapTail(slice: string, maxChars: number): string {
  const clipped = slice.slice(slice.length - maxChars);
  const nl = clipped.indexOf("\n");
  return nl < 0 ? clipped : clipped.slice(nl + 1);
}

/**
 * Cap `text` to a head/tail window.
 *
 * The line budget is applied first: a 5 000-line log is over budget even when
 * it is short in characters, and slicing by characters alone would keep
 * thousands of tiny lines. The character budget is applied last, snapped to
 * line boundaries so a long line is never shown half (a half line reads as a
 * different value).
 */
export function capToolOutput(text: string, limits: ToolOutputLimits = {}): CappedToolOutput {
  const maxChars = limits.maxChars ?? TOOL_OUTPUT_MAX_CHARS;
  const maxLines = limits.maxLines ?? TOOL_OUTPUT_MAX_LINES;
  const lines = text.split("\n");
  if (text.length <= maxChars && lines.length <= maxLines) {
    return { text, truncated: false, hiddenChars: 0, hiddenLines: 0 };
  }

  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;

  let head: string;
  let tail: string;
  if (lines.length > maxLines) {
    const headLines = Math.floor(maxLines / 2);
    head = lines.slice(0, headLines).join("\n");
    tail = lines.slice(lines.length - (maxLines - headLines)).join("\n");
  } else {
    head = text.slice(0, headChars);
    tail = text.slice(text.length - tailChars);
  }
  if (head.length > headChars) head = snapHead(head, headChars);
  if (tail.length > tailChars) tail = snapTail(tail, tailChars);

  const hiddenChars = Math.max(0, text.length - head.length - tail.length);
  const hiddenLines = Math.max(0, countLines(text) - countLines(head) - countLines(tail));
  return {
    text: `${head}\n…（已省略 ${hiddenLines} 行 / ${hiddenChars} 字符）…\n${tail}`,
    truncated: true,
    hiddenChars,
    hiddenLines,
  };
}