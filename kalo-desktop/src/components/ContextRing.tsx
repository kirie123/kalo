import { useChatSelector, chatStore } from "../lib/chat-store";

/**
 * Circular context-usage indicator. The ring fills with the used percentage;
 * the number in the middle is the integer 0-100 percent. Tokens are shown
 * in K units; hover shows exact usage.
 */
function formatK(n: number): string {
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
}
export { formatK };

export default function ContextRing() {
  const { contextUsage, isCompacting, sessionId } = useChatSelector((s) => ({
    contextUsage: s.contextUsage,
    isCompacting: s.isCompacting,
    sessionId: s.sessionId,
  }));

  const percent = contextUsage?.percent ?? null;
  const tokens = contextUsage?.tokens ?? null;
  const window_ = contextUsage?.contextWindow ?? null;

  const R = 7;
  const C = 2 * Math.PI * R;
  const pct = percent === null ? 0 : Math.min(100, Math.max(0, Math.round(percent)));
  const danger = pct >= 80;

  const tooltip =
    (tokens !== null && window_ !== null
      ? `上下文：${formatK(tokens)} / ${formatK(window_)} tokens（${pct}%）`
      : window_ !== null
        ? `上下文窗口：${formatK(window_)} tokens（压缩后暂无精确用量）`
        : "暂无上下文数据（开始对话后显示）") + (sessionId ? "，点击压缩上下文" : "");

  return (
    <div className="group relative flex h-6 w-6 shrink-0">
      <button
        onClick={() => void chatStore.compact()}
        disabled={!sessionId || isCompacting}
        className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-base disabled:opacity-50"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" className={isCompacting ? "animate-spin" : ""}>
          {/* Track */}
          <circle cx="10" cy="10" r={R} fill="none" stroke="var(--border)" strokeWidth="2" />
          {/* Progress arc, starting at 12 o'clock */}
          <circle
            cx="10"
            cy="10"
            r={R}
            fill="none"
            stroke={danger ? "var(--danger)" : "var(--ok)"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * C} ${C}`}
            transform="rotate(-90 10 10)"
          />
          <text
            x="10"
            y="10"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="6.5"
            fill={danger ? "var(--danger)" : "var(--text-dim)"}
          >
            {percent === null ? "–" : pct}
          </text>
        </svg>
      </button>
      {/* Custom tooltip: native title= takes ~1s to appear; this shows in ~100ms. */}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 rounded-md border border-edge bg-card px-2 py-1 text-xs whitespace-nowrap text-dim opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-100">
        {tooltip}
      </div>
    </div>
  );
}
