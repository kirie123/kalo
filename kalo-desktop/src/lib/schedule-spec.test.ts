import { describe, expect, it } from "vitest";
import { buildCron, describeCron, parseSpec, validateSpec } from "./schedule-spec";

/** 这层的价值全在往返一致：界面改的是频率，存的是 cron，
 *  下次打开又要从 cron 还原出同一个界面状态。 */
function roundTrip(cron: string) {
  return buildCron(parseSpec(cron));
}

describe("parseSpec / buildCron", () => {
  it("认得出五种常见形状", () => {
    expect(parseSpec("*/10 * * * *").freq).toBe("minutes");
    expect(parseSpec("5 * * * *").freq).toBe("hourly");
    expect(parseSpec("5 17 * * *").freq).toBe("daily");
    expect(parseSpec("5 17 * * 1-5").freq).toBe("weekdays");
    expect(parseSpec("5 17 * * 1,3").freq).toBe("weekly");
    expect(parseSpec("5 17 1 * *").freq).toBe("monthly");
  });

  it("cron → 界面 → cron 不走样", () => {
    for (const c of ["*/10 * * * *", "5 * * * *", "5 17 * * *", "5 17 * * 1-5", "5 17 1 * *"]) {
      expect(roundTrip(c)).toBe(c);
    }
    // 周几会规范化成逗号列表，语义相同
    expect(roundTrip("5 17 * * 1,3")).toBe("5 17 * * 1,3");
  });

  it("解析出的时刻是对的", () => {
    const s = parseSpec("5 17 * * 1-5");
    expect([s.hour, s.minute]).toEqual([17, 5]);
    expect(parseSpec("5 17 * * 1,3").weekdays).toEqual([1, 3]);
    expect(parseSpec("0 9 15 * *").dom).toBe(15);
  });

  it("周日的两种写法都归到 0", () => {
    expect(parseSpec("0 9 * * 7").weekdays).toEqual([0]);
    expect(parseSpec("0 9 * * 0").weekdays).toEqual([0]);
  });

  it("七天全选等价于每天", () => {
    expect(parseSpec("0 9 * * 0-6").freq).toBe("daily");
    expect(buildCron({ ...parseSpec("0 9 * * 1"), weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("0 9 * * *");
  });

  it("表达不了的落到 custom 而不是猜", () => {
    // 一天两次
    expect(parseSpec("0 9,18 * * *").freq).toBe("custom");
    // 日与周同时限定：cron 是「或」语义
    expect(parseSpec("0 9 1 * 1").freq).toBe("custom");
    // 限定月份
    expect(parseSpec("0 9 1 3 *").freq).toBe("custom");
    // 字段数不对 / 语法不认识
    expect(parseSpec("0 9 * *").freq).toBe("custom");
    expect(parseSpec("x 9 * * *").freq).toBe("custom");
  });

  it("custom 原样保留 cron", () => {
    expect(roundTrip("0 9,18 * * *")).toBe("0 9,18 * * *");
  });
});

describe("describeCron", () => {
  it("说人话", () => {
    expect(describeCron("*/10 * * * *")).toBe("每 10 分钟");
    expect(describeCron("5 * * * *")).toBe("每小时第 5 分");
    expect(describeCron("5 17 * * *")).toBe("每天 17:05");
    expect(describeCron("5 17 * * 1-5")).toBe("工作日 17:05");
    expect(describeCron("0 9 * * 1,3")).toBe("每周一、三 09:00");
    expect(describeCron("0 9 15 * *")).toBe("每月 15 日 09:00");
  });

  it("认不出来就把 cron 原样显示，不编话", () => {
    expect(describeCron("0 9,18 * * *")).toBe("0 9,18 * * *");
    expect(describeCron("")).toBe("未设置");
  });
});

describe("validateSpec", () => {
  it("拦住空的周几与越界间隔", () => {
    expect(validateSpec({ ...parseSpec("0 9 * * 1"), freq: "weekly", weekdays: [] })).toBeTruthy();
    expect(validateSpec({ ...parseSpec("*/10 * * * *"), everyMin: 0 })).toBeTruthy();
    expect(validateSpec(parseSpec("*/10 * * * *"))).toBeNull();
  });

  it("custom 只查字段数", () => {
    expect(validateSpec(parseSpec("0 9 * *"))).toBeTruthy();
    expect(validateSpec(parseSpec("0 9,18 * * *"))).toBeNull();
  });
});
