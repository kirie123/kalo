import { useState } from "react";

interface RetryNoticeProps {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  done?: { success: boolean; finalError?: string };
}

/** Banner for engine auto-retry; red when the final attempt failed. */
export default function RetryNotice({ attempt, maxAttempts, delayMs, errorMessage, done }: RetryNoticeProps) {
  const [open, setOpen] = useState(false);

  if (done?.success) {
    return <div className="text-center text-xs text-[var(--ok)]">第 {attempt} 次自动重试成功</div>;
  }

  const failed = done && !done.success;
  const summary = (failed ? done.finalError : errorMessage) ?? "";
  const firstLine = summary.split("\n")[0]?.slice(0, 140) ?? "";

  return (
    <div
      className={`rounded-md border px-3 py-1.5 text-xs ${
        failed
          ? "border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--danger)]"
          : "border-[var(--warn-border)] bg-[var(--warn-bg)]"
      }`}
    >
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <span>
          {failed
            ? `自动重试失败（第 ${attempt}/${maxAttempts} 次）`
            : `请求失败，${Math.round(delayMs / 1000)} 秒后自动重试（第 ${attempt}/${maxAttempts} 次）`}
        </span>
        {firstLine && <span className="truncate text-xs opacity-80">— {firstLine}</span>}
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && summary && (
        <pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs opacity-90">{summary}</pre>
      )}
    </div>
  );
}
