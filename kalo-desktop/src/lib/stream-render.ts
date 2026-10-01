/**
 * Streaming render budget (doc/2026-10-01-高负载下界面响应与输入可见性.md §3).
 *
 * A streaming text block re-parses the whole accumulated Markdown on every
 * delta, and that cost grows with the text: measured 37 ms at 20 KB, 65 ms at
 * 40 KB, 141 ms at 80 KB — while deltas keep arriving several times a second.
 * The main thread ends up saturated, so keystrokes stop echoing and the window
 * reads as "frozen although it looks fine".
 *
 * Pure decisions live here (no DOM, no React) so they can be unit tested; the
 * component only applies them.
 */

/** Minimum gap between two full Markdown parses while a block streams. */
export const STREAM_PARSE_INTERVAL_MS = 300;

/**
 * Above this size, a streaming block renders as plain text and is formatted
 * once the stream ends. Throttling alone is not enough there: even at 4 parses
 * per second an 80 KB block would burn ~56% of a core.
 */
export const STREAM_MARKDOWN_MAX_CHARS = 24_000;

/** Should this frame skip Markdown and render the raw text? */
export function shouldStreamAsPlainText(text: string, streaming: boolean): boolean {
  return streaming && text.length > STREAM_MARKDOWN_MAX_CHARS;
}

/** Has enough time passed since the last parse to run another one? */
export function shouldCommitStreamParse(
  lastParseMs: number,
  nowMs: number,
  intervalMs: number = STREAM_PARSE_INTERVAL_MS,
): boolean {
  if (lastParseMs <= 0) return true;
  return nowMs - lastParseMs >= intervalMs;
}