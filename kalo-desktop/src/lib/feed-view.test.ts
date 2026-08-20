import { describe, expect, it } from "vitest";
import { fmtClock, fmtEvery, tickerEntries, trendClass } from "./feed-view";
import type { FeedInfo, FeedItem, FeedSnapshot } from "../types";

function feed(over: Partial<FeedInfo> = {}): FeedInfo {
  return {
    id: "f1",
    name: "A股大盘",
    everySec: 20,
    surface: "ticker",
    enabled: true,
    request: { url: "https://example.test/q" },
    fields: {},
    template: "{name} {price}",
    snapshot: null,
    nextPullAt: null,
    consecutiveFailures: 0,
    ...over,
  };
}

function snapshot(items: FeedItem[], over: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return { id: "f1", at: "2026-08-20T10:00:00.000Z", ok: true, ms: 42, items, ...over };
}

const UP: FeedItem = { text: "上证指数 3421.5 +0.62%", trend: "up" };
const DOWN: FeedItem = { text: "深证成指 10874.20 -0.31%", trend: "down" };

describe("fmtEvery", () => {
  it("keeps seconds under a minute", () => {
    expect(fmtEvery(20)).toBe("20 秒");
    expect(fmtEvery(90)).toBe("90 秒");
  });

  it("prefers the largest exact unit", () => {
    expect(fmtEvery(60)).toBe("1 分钟");
    expect(fmtEvery(300)).toBe("5 分钟");
    expect(fmtEvery(3600)).toBe("1 小时");
    expect(fmtEvery(7200)).toBe("2 小时");
  });
});

describe("fmtClock", () => {
  it("marks a missing timestamp", () => {
    expect(fmtClock(null)).toBe("—");
    expect(fmtClock("")).toBe("—");
  });

  it("passes an unparsable string through instead of showing NaN", () => {
    expect(fmtClock("刚刚")).toBe("刚刚");
  });

  it("renders zero-padded local wall-clock time", () => {
    // Built from local parts so the assertion holds in any timezone.
    const iso = new Date(2026, 7, 20, 9, 5, 3).toISOString();
    expect(fmtClock(iso)).toBe("09:05:03");
  });
});

describe("trendClass", () => {
  it("uses the Chinese convention: up red, down green", () => {
    expect(trendClass("up")).toBe("text-[var(--danger)]");
    expect(trendClass("down")).toBe("text-[var(--ok)]");
  });

  it("falls back to dim for flat and unknown trends", () => {
    expect(trendClass("flat")).toBe("text-dim");
    expect(trendClass(null)).toBe("text-dim");
    expect(trendClass(undefined)).toBe("text-dim");
  });
});

describe("tickerEntries", () => {
  it("flattens every enabled ticker feed's items, in table order", () => {
    const entries = tickerEntries([
      feed({ id: "a", snapshot: snapshot([UP]) }),
      feed({ id: "b", name: "USD/CNY", snapshot: snapshot([DOWN]) }),
    ]);
    expect(entries.map((e) => e.text)).toEqual([UP.text, DOWN.text]);
  });

  it("skips disabled feeds, other surfaces, and feeds that never pulled", () => {
    const entries = tickerEntries([
      feed({ id: "off", enabled: false, snapshot: snapshot([UP]) }),
      feed({ id: "card", surface: "card", snapshot: snapshot([UP]) }),
      feed({ id: "fresh", snapshot: null }),
    ]);
    expect(entries).toEqual([]);
  });

  it("names the source and pull time in the tooltip", () => {
    const [e] = tickerEntries([feed({ snapshot: snapshot([UP], { at: new Date(2026, 7, 20, 14, 30, 0).toISOString() }) })]);
    expect(e.detail).toBe("A股大盘 · 14:30:00");
  });

  it("keeps stale values but says so, and appends the error", () => {
    const [e] = tickerEntries([
      feed({ snapshot: snapshot([UP], { ok: false, stale: true, error: "HTTP 429" }) }),
    ]);
    expect(e.text).toBe(UP.text);
    expect(e.detail).toContain("旧值");
    expect(e.detail).toContain("HTTP 429");
  });
});
