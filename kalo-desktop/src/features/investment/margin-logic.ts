export interface MarginPoint {
  date: string; financingBalance: number; financingBuy: number; financingRepay: number | null;
  shortBalance: number; shortVolume: number; shortSellVolume: number; totalBalance: number;
}
export interface MarginSnapshot {
  kind: "marginSnapshot"; schemaVersion: number; id: string; createdAt: string; source: string;
  sourceHash: string; rawIds: string[]; shanghai: MarginPoint[]; shenzhen: MarginPoint[]; hikvision: MarginPoint[]; warnings: string[];
}
export type MarginScope = "combined" | "shanghai" | "shenzhen" | "hikvision";
export const marginScopes: [MarginScope, string][] = [["combined", "沪深合计"], ["shanghai", "沪市"], ["shenzhen", "深市"], ["hikvision", "海康威视"]];
export function marginSeries(snapshot: MarginSnapshot, scope: MarginScope): MarginPoint[] {
  if (scope !== "combined") return snapshot[scope];
  return snapshot.shanghai.flatMap(sh => {
    const sz = snapshot.shenzhen.find(p => p.date === sh.date);
    if (!sz) return [];
    return [{ date: sh.date, financingBalance: sh.financingBalance + sz.financingBalance,
      financingBuy: sh.financingBuy + sz.financingBuy,
      financingRepay: sh.financingRepay === null || sz.financingRepay === null ? null : sh.financingRepay + sz.financingRepay,
      shortBalance: sh.shortBalance + sz.shortBalance, shortVolume: sh.shortVolume + sz.shortVolume,
      shortSellVolume: sh.shortSellVolume + sz.shortSellVolume, totalBalance: sh.totalBalance + sz.totalBalance }];
  });
}
