/**
 * Code-aware scanning of a markdown source.
 *
 * Both rich-content passes (SVG extraction, HTML downgrade) must leave code
 * alone: an ```html fence or an inline `<h3>` is documentation about a tag,
 * not a tag. They share this scanner so "what counts as code" is defined once.
 */

export type Range = { start: number; end: number };

/** Half-open ranges of `text` that are outside fenced blocks and code spans. */
export function plainRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  let i = 0;
  let fence: string | null = null;

  const close = (end: number) => {
    if (end > start) ranges.push({ start, end });
  };

  while (i < text.length) {
    if (atLineStart(text, i)) {
      const run = matchFence(text, i);
      if (run) {
        if (fence === null) {
          close(i);
          fence = run.marker;
        } else if (run.marker[0] === fence[0] && run.marker.length >= fence.length) {
          fence = null;
          start = run.end;
        }
        i = run.end;
        continue;
      }
    }
    if (fence !== null) {
      i += 1;
      continue;
    }
    if (text[i] === "`") {
      const ticks = runLength(text, i, "`");
      const end = text.indexOf("`".repeat(ticks), i + ticks);
      close(i);
      i = end === -1 ? i + ticks : end + ticks;
      start = i;
      continue;
    }
    i += 1;
  }
  if (fence === null) close(text.length);
  return ranges;
}

/** Rewrite only the parts of `text` that are outside code. */
export function mapOutsideCode(text: string, transform: (slice: string) => string): string {
  const ranges = plainRanges(text);
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start);
    out += transform(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function atLineStart(text: string, i: number): boolean {
  return i === 0 || text[i - 1] === "\n";
}

/** A ``` / ~~~ fence line at `i`; `end` is just past its newline. */
function matchFence(text: string, i: number): { marker: string; end: number } | null {
  // Up to three spaces of indent are still a fence in CommonMark.
  let j = i;
  let indent = 0;
  while (indent < 3 && (text[j] === " " || text[j] === "\t")) {
    j += 1;
    indent += 1;
  }
  const ch = text[j];
  if (ch !== "`" && ch !== "~") return null;
  const run = runLength(text, j, ch);
  if (run < 3) return null;
  const nl = text.indexOf("\n", j);
  return { marker: ch.repeat(run), end: nl === -1 ? text.length : nl + 1 };
}

function runLength(text: string, i: number, ch: string): number {
  let n = 0;
  while (text[i + n] === ch) n += 1;
  return n;
}
