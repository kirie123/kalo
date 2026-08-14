import { useEffect, useState } from "react";
import { formatApiError } from "../lib/error-format";

interface RetryNoticeProps {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  done?: { success: boolean; finalError?: string };
}

/** Banner for engine auto-retry; counts down the delay, red on final failure. */
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
    ? `自动重试失败（第 ${attempt}/${maxAttempts} 次）`
    : secsLeft > 0
      ? `请求失败，${secsLeft} 秒后自动重试（第 ${attempt}/${maxAttempts} 次）`
      : `正在重试（第 ${attempt}/${maxAttempts} 次）…`;

  return (
    <div
      className={`rounded-md border px-3 py-1.5 text-xs ${
        failed
          ? "border-[var(--error-border)] bg-[var(--error-bg)]"
          : "border-[var(--warn-border)] bg-[var(--warn-bg)]"
      }`}
    >
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <span className={failed ? "font-medium text-[var(--danger)]" : "font-medium"}>{title}</span>
        {parsed.detail && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`ml-auto shrink-0 opacity-60 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <div className={`mt-0.5 ${failed ? "text-[var(--danger)]" : "text-dim"}`}>{parsed.summary}</div>
      {open && parsed.detail && (
        <pre className="mono mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 opacity-80">
          {parsed.detail}
        </pre>
      )}
    </div>
  );
}
