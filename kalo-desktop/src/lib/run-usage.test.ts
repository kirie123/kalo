import { describe, expect, it } from "vitest";
import { cacheHitRate, formatK, formatRunUsage } from "./run-usage";
import type { TurnUsage } from "./timeline";

function usage(u: Partial<TurnUsage>): TurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, ...u };
}

describe("formatK", () => {
  it("keeps one decimal below 10K and rounds above", () => {
    expect(formatK(0)).toBe("0.0K");
    expect(formatK(1234)).toBe("1.2K");
    expect(formatK(9900)).toBe("9.9K");
    expect(formatK(198_000)).toBe("198K");
    expect(formatK(793_000)).toBe("793K");
  });
});

describe("cacheHitRate", () => {
  it("is the cached share of the input side", () => {
    expect(cacheHitRate(usage({ input: 1000, cacheRead: 3000 }))).toBe(75);
    expect(cacheHitRate(usage({ input: 0, cacheRead: 792_000 }))).toBe(100);
  });

  it("is null when nothing was sent on the input side", () => {
    expect(cacheHitRate(usage({ output: 500 }))).toBeNull();
  });
});

describe("formatRunUsage", () => {
  it("names the call count so a total above the context window is explainable", () => {
    // The 200K-window overflow-retry loop: 4 calls × ~198K resent context, no output.
    expect(formatRunUsage(usage({ input: 0, cacheRead: 792_000, output: 0, calls: 4 }))).toBe(
      "本轮累计（4 次调用）：输入 792K · 输出 0.0K · 缓存命中 100%",
    );
  });

  it("sums the input side across fresh and cached tokens", () => {
    expect(formatRunUsage(usage({ input: 2000, cacheRead: 18_000, output: 1500, calls: 2 }))).toBe(
      "本轮累计（2 次调用）：输入 20K · 输出 1.5K · 缓存命中 90%",
    );
  });

  it("drops the hit rate when there is no input side", () => {
    expect(formatRunUsage(usage({ output: 120, calls: 1 }))).toBe("本轮累计（1 次调用）：输入 0.0K · 输出 0.1K");
  });
});
