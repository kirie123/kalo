import { useEffect, useRef, useState } from "react";
import {
  STREAM_PARSE_INTERVAL_MS,
  shouldCommitStreamParse,
  shouldStreamAsPlainText,
} from "../lib/stream-render";
import { MarkdownBlock } from "./MarkdownBlock";

/**
 * One assistant text block, cheap while it streams.
 *
 * Without this, every delta re-parses the whole accumulated Markdown (the
 * memo only shields *finished* blocks) and a long answer saturates the main
 * thread — measured 49 ms average per delta at 40 KB, while deltas arrive
 * several times a second. That is what makes the window swallow typing while
 * a long run is going (doc/2026-10-01-高负载下界面响应与输入可见性.md §3).
 *
 * Rules (pure parts in lib/stream-render.ts):
 *   - short block, streaming: at most one full parse per
 *     `STREAM_PARSE_INTERVAL_MS`, with a trailing commit so the last delta is
 *     not left unrendered when the stream pauses;
 *   - long block, streaming: render the raw text (cheap) — formatting a block
 *     that size repeatedly is not worth any viewport fidelity;
 *   - not streaming: always the full Markdown, so the settled view is exactly
 *     what this component produced before it existed.
 */
export default function StreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const lastParse = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = text;

  const cancelPending = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    if (!streaming) {
      // Final text always lands, immediately: this is the view that persists.
      cancelPending();
      setShown(text);
      return;
    }
    // Long block: the render path below reads `text` directly; no parse here.
    if (shouldStreamAsPlainText(text, true)) {
      cancelPending();
      return;
    }
    if (shouldCommitStreamParse(lastParse.current, Date.now())) {
      cancelPending();
      lastParse.current = Date.now();
      setShown(text);
      return;
    }
    // Too soon: schedule the trailing commit so the last delta of a burst is
    // not left unrendered when the stream pauses between tool calls.
    if (timer.current === null) {
      const wait = STREAM_PARSE_INTERVAL_MS - (Date.now() - lastParse.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        lastParse.current = Date.now();
        setShown(latest.current);
      }, wait);
    }
  }, [text, streaming]);

  useEffect(() => cancelPending, []);

  // Plain text while a long block streams: one text node instead of a
  // remark/rehype pass per delta. The wrapper's streaming cursor still shows.
  if (shouldStreamAsPlainText(text, streaming)) {
    return <div className="whitespace-pre-wrap">{text}</div>;
  }
  return <MarkdownBlock text={shown} />;
}