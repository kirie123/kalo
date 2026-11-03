import { describe, expect, it } from "vitest";
import { marginSeries, type MarginPoint, type MarginSnapshot } from "./margin-logic";
describe("两融同日合计", () => {
  it("不拼接错日数据，也不把缺失偿还额当零", () => {
    const p: MarginPoint = { date: "2026-11-02", financingBalance: 100, financingBuy: 10, financingRepay: 5, shortBalance: 20, shortVolume: 2, shortSellVolume: 1, totalBalance: 120 };
    const snapshot = { shanghai: [{ ...p, date: "2026-10-30" }, p], shenzhen: [{ ...p, financingRepay: null }] } as MarginSnapshot;
    const combined = marginSeries(snapshot, "combined");
    expect(combined).toHaveLength(1);
    expect(combined[0].date).toBe("2026-11-02");
    expect(combined[0].totalBalance).toBe(240);
    expect(combined[0].financingRepay).toBeNull();
  });
});
