import { useEffect, useRef, useState } from "react";

/**
 * Small icon button that copies text to the clipboard. Flips to a check mark
 * for 2.5 seconds on success; failure stays visible until the next attempt.
 */
export default function CopyButton({ text, title = "复制" }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const attempt = useRef(0);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    attempt.current += 1;
  }, []);

  const copy = async () => {
    const current = ++attempt.current;
    window.clearTimeout(timer.current);
    setFailed(false);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(text);
      if (current !== attempt.current) return;
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 2500);
    } catch {
      if (current === attempt.current) setFailed(true);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "已复制" : failed ? "复制失败，点击重试" : title}
      aria-label={copied ? "已复制" : failed ? "复制失败，点击重试" : title}
      data-copied={copied}
      data-failed={failed}
      className="copy-button rounded p-1 text-dim hover:text-ink"
    >
      <svg aria-hidden="true" className="copy-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg aria-hidden="true" className="copy-glyph" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5V9A1.5 1.5 0 0 0 4 10.5h1.5" />
      </svg>
      {failed && <span aria-hidden="true" className="copy-error">复制失败，点击重试</span>}
      <span className="sr-only" role="status">{copied ? "已复制" : failed ? "复制失败，点击重试" : ""}</span>
    </button>
  );
}
