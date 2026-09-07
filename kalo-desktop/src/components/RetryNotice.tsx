import { useEffect, useState } from "react";
import { formatApiError } from "../lib/error-format";

interface RetryNoticeProps {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  done?: { success: boolean; finalError?: string };
}

/**
 * Compact one-line indicator for engine auto-retry: spinner + attempt count,
 * click to expand the actual error. Turns red once retries are exhausted.
 */
export default function RetryNotice({ attempt, maxAttempts, delayMs, errorMessage, done }: RetryNoticeProps) {
  const [open, setOpen] = useState(false);
  const totalSecs = Math.max(1, Math.round(delayMs / 1000));
  const [secsLeft, setSecsLeft] = useState(totalSecs);

  // Cosmetic countdown; the engine retries on its own schedule and reports
  // via done, at which point the ticker stops.
  useEffect(() => {
    if (done) return;
    setSecsLeft(totalSecs);
    const timer = setInterval(() => setSecsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [done, totalSecs]);

  if (done?.success) {
    return <div className="px-2 text-xs text-[var(--ok)]">✓ 第 {attempt} 次自动重试成功</div>;
  }

  const failed = done && !done.success;
  const parsed = formatApiError(failed ? (done.finalError ?? errorMessage) : errorMessage);

  const title = failed
    ? `连接失败，自动重试 ${attempt}/${maxAttempts} 次均失败`
    : secsLeft > 0
      ? `连接失败，${secsLeft} 秒后重连（第 ${attempt}/${maxAttempts} 次）`
      : `正在重连（第 ${attempt}/${maxAttempts} 次）…`;

  return (
    <div
      className={`rounded-md border px-2.5 py-1 text-xs ${
        failed
          ? "border-[var(--error-border)] bg-[var(--error-bg)]"
          : "border-[var(--warn-border)] bg-[var(--warn-bg)]"
      }`}
    >
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        {failed ? (
          <span className="shrink-0 font-medium text-[var(--danger)]">✕</span>
        ) : (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-3 w-3 shrink-0 animate-spin opacity-70"
          >
            <path d="M8 2a6 6 0 1 1-5.2 3" strokeLinecap="round" />
          </svg>
        )}
        <span className={`shrink-0 font-medium ${failed ? "text-[var(--danger)]" : ""}`}>{title}</span>
        <span className={`min-w-0 flex-1 truncate ${failed ? "text-[var(--danger)]" : "text-dim"}`}>
          {parsed.summary}
        </span>
        {parsed.detail && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`shrink-0 opacity-60 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open && (
        <pre className="mono mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 opacity-80">
          {parsed.detail || parsed.summary}
        </pre>
      )}
    </div>
  );
}
