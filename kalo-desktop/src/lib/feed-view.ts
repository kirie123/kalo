import type { FeedInfo, FeedItem, FeedTrend } from "../types";

/**
 * Pure view helpers shared by the title-bar ticker and the 数据源 panel
 * (doc/2026-08-20-feeds-declarative-data-pull.md). Kept out of the components
 * so the selection and formatting rules are testable on their own.
 */

export interface TickerEntry extends FeedItem {
  /** Tooltip: source name, last pull time, and a stale/error note when relevant. */
  detail: string;
}

/** ISO timestamp -> local "HH:mm:ss"; empty -> "—", unparsable -> as-is. */
export function fmtClock(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Pull interval, seconds on the wire -> "45 秒" / "5 分钟" / "1 小时". */
export function fmtEvery(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} 小时`;
  if (sec % 60 === 0) return `${sec / 60} 分钟`;
  return `${sec} 秒`;
}

/**
 * Up is RED and down is GREEN — the Chinese market convention, which is what
 * every bundled source (A股 / 人民币) is read against. Note this inverts the
 * usual meaning of --ok / --danger; the vars are used purely as the theme's red
 * and green here.
 */
export function trendClass(trend: FeedTrend | null | undefined): string {
  if (trend === "up") return "text-[var(--danger)]";
  if (trend === "down") return "text-[var(--ok)]";
  return "text-dim";
}

/**
 * Every item the ticker should scroll: enabled `ticker` feeds that have pulled
 * at least once, in table order. A failing feed still contributes its last good
 * values — the strip says "stale" in the tooltip rather than going blank.
 */
export function tickerEntries(feeds: FeedInfo[]): TickerEntry[] {
  const out: TickerEntry[] = [];
  for (const f of feeds) {
    if (!f.enabled || f.surface !== "ticker") continue;
    const snap = f.snapshot;
    if (!snap) continue;
    const detail = [
      `${f.name} · ${fmtClock(snap.at)}`,
      snap.stale ? "（旧值，最近一次拉取未成功）" : "",
      snap.error ? `\n${snap.error}` : "",
    ]
      .filter(Boolean)
      .join("");
    for (const item of snap.items) out.push({ ...item, detail });
  }
  return out;
}
