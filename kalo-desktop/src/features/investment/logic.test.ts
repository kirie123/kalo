import { describe, it, expect } from "vitest";
import { flowWindow, specError, defaultSpec, rankedFlows } from "./logic";
import type { Instrument, Snapshot } from "./types";
const instrument: Instrument = {
  code: "510300.SH",
  name: "test",
  bars: Array.from({ length: 28 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: 4,
    close: 4,
    high: 5,
    low: 3,
    adjustedClose: 4,
    volume: 10000,
  })),
  funds: [],
};
const snapshot: Snapshot = {
  id: "test",
  createdAt: "",
  source: "test",
  warnings: [],
  instruments: [instrument],
};
describe("investment coverage and form", () => {
  it("ranks complete zero and negative flows ahead of missing data without changing the pool", () => {
    const complete = (code: string, netFlow: number) => ({ ...instrument, code, funds: instrument.bars.slice(-5).map(b => ({ date: b.date, shares: 100, nav: 4, netFlow, availableAt: "" })) });
    const pool = { ...snapshot, instruments: [instrument, complete("negative", -2), complete("zero", 0), complete("positive", 3)] };
    const rows = rankedFlows(pool, 5);
    expect(rows.map(r => r.instrument.code)).toEqual(["positive", "zero", "negative", instrument.code]);
    expect(rows.map(r => r.flow.total)).toEqual([15, 0, -10, null]);
    expect(pool.instruments[0]).toBe(instrument);
  });
  it("does not use old available points to cover a missing latest trading day", () => {
    const funds = instrument.bars
      .slice(-6, -1)
      .map((b) => ({
        date: b.date,
        shares: 100,
        nav: 4,
        netFlow: 0,
        availableAt: "",
      }));
    expect(flowWindow({ ...instrument, funds }, 5)).toMatchObject({
      total: null,
      count: 4,
    });
  });
  it("distinguishes zero flow from missing flow", () => {
    const funds = instrument.bars
      .slice(-5)
      .map((b) => ({
        date: b.date,
        shares: 100,
        nav: 4,
        netFlow: 0,
        availableAt: "",
      }));
    expect(flowWindow({ ...instrument, funds }, 5).total).toBe(0);
  });
  it("requires prewarm data and bounded integer windows", () => {
    const spec = defaultSpec(snapshot);
    expect(specError({ ...spec, holdings: 1 }, snapshot)).toBeNull();
    expect(
      specError({ ...spec, holdings: 1, start: "2026-01-01" }, snapshot),
    ).not.toBeNull();
    expect(specError({ ...spec, lookback: 2.5 }, snapshot)).not.toBeNull();
  });
});
