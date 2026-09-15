import type { TurnUsage } from "./timeline";

/** Token counts in K units: one decimal below 10K, rounded above. */
export function formatK(n: number): string {
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
}

/** Cache reads over all input-side tokens (fresh + cached); null when there is no input side. */
export function cacheHitRate(usage: TurnUsage): number | null {
  const inputSide = usage.input + usage.cacheRead;
  return inputSide > 0 ? Math.round((usage.cacheRead / inputSide) * 100) : null;
}

/**
 * Footer line for one agent run.
 *
 * A run spans several LLM calls — the tool loop, plus any compact-and-retry
 * attempts — and every call resends the whole context. So the input total
 * routinely exceeds the model's context window, which reads as a miscount
 * unless the call count is spelled out: 793K input over 4 calls against a
 * 200K window is 4 × ~198K, not a bug. A run that burns calls with no output
 * (failed retries) becomes visible here too.
 * (doc/2026-08-15-turn-usage-footer.md)
 */
export function formatRunUsage(usage: TurnUsage): string {
  const inputSide = usage.input + usage.cacheRead;
  const rate = cacheHitRate(usage);
  return (
    `本轮累计（${usage.calls} 次调用）：输入 ${formatK(inputSide)} · 输出 ${formatK(usage.output)}` +
    (rate !== null ? ` · 缓存命中 ${rate}%` : "")
  );
}
