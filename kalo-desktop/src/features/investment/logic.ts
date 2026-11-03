import type { Snapshot, Spec, Instrument } from "./types";
export const formatMoney = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export const percent = (n: number) => `${(n * 100).toFixed(2)}%`;
export function defaultSpec(snapshot: Snapshot): Spec {
  const bars = snapshot.instruments[0]?.bars ?? [];
  return {
    snapshotId: snapshot.id,
    codes: snapshot.instruments.map(i => i.code),
    start: bars[Math.max(21, bars.length - 60)]?.date ?? "",
    end: bars.at(-1)?.date ?? "",
    capital: 1000000,
    lookback: 20,
    rebalance: 5,
    holdings: Math.min(2, snapshot.instruments.length),
    commissionBps: 2.5,
    minimumFee: 5,
    slippageBps: 5,
    flowFilter: false,
  };
}
export function flowWindow(
  instrument: Instrument,
  days: number,
): { total: number | null; count: number; date: string } {
  const dates = instrument.bars.slice(-days).map((b) => b.date);
  const points = dates.map((d) => instrument.funds.find((f) => f.date === d));
  const valid = points.filter((p) => p?.netFlow != null);
  return {
    total:
      valid.length === days
        ? valid.reduce((s, p) => s + (p!.netFlow ?? 0), 0)
        : null,
    count: valid.length,
    date: dates.at(-1) ?? "",
  };
}
export function specError(spec: Spec, snapshot: Snapshot): string | null {
  const bars = snapshot.instruments[0]?.bars ?? [];
  if (spec.codes && (!Array.isArray(spec.codes) || !spec.codes.length || new Set(spec.codes).size !== spec.codes.length || spec.codes.some(code => !snapshot.instruments.some(i => i.code === code))))
    return "请选择当前快照内不重复的回测标的";
  if (!spec.start || !spec.end || spec.start > spec.end)
    return "请选择有效起止日期";
  if (
    !Number.isInteger(spec.lookback) ||
    spec.lookback < 2 ||
    spec.lookback > 120
  )
    return "动量窗口应为 2–120 个交易日";
  if (
    !Number.isInteger(spec.rebalance) ||
    spec.rebalance < 1 ||
    spec.rebalance > 60
  )
    return "调仓间隔应为 1–60 个交易日";
  if (
    !Number.isInteger(spec.holdings) ||
    spec.holdings < 1 ||
    spec.holdings > (spec.codes?.length ?? snapshot.instruments.length)
  )
    return "持仓数量超出证券池范围";
  if (
    spec.start < (bars[spec.lookback + 1]?.date ?? "9999") ||
    spec.end > (bars.at(-1)?.date ?? "")
  )
    return "日期超出可用行情或未留足预热窗口";
  if (
    !Number.isFinite(spec.capital) ||
    spec.capital < 1000 ||
    spec.capital > 100000000
  )
    return "初始资金应为 1000–1 亿";
  if (
    [spec.commissionBps, spec.slippageBps].some(
      (x) => !Number.isFinite(x) || x < 0 || x > 100,
    ) ||
    !Number.isFinite(spec.minimumFee) ||
    spec.minimumFee < 0 ||
    spec.minimumFee > 1000
  )
    return "请检查费用和滑点范围";
  return null;
}

export function rankedFlows(snapshot: Snapshot, days: number) {
  return snapshot.instruments
    .map(instrument => ({ instrument, flow: flowWindow(instrument, days) }))
    .sort((a, b) => {
      if (a.flow.total == null && b.flow.total != null) return 1;
      if (b.flow.total == null && a.flow.total != null) return -1;
      return (b.flow.total ?? 0) - (a.flow.total ?? 0) || a.instrument.code.localeCompare(b.instrument.code);
    });
}

export const categories = ["全部", "宽基", "双创", "行业主题"] as const;
export function categoryOf(instrument: Instrument): string {
  return instrument.category || (["510300.SH", "510500.SH", "512100.SH"].includes(instrument.code) ? "宽基" : "未分类");
}
export function inCategory(instruments: Instrument[], category: string): Instrument[] {
  return category === "全部" ? instruments : instruments.filter(i => categoryOf(i) === category);
}
