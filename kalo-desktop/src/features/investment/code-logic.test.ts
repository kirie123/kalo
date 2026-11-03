import { describe, it, expect } from "vitest";
import { codeDefaults, codeError, researchContext } from "./code-logic";
import type { Dataset } from "./code-types";
const data = { id: "frozen", security: { name: "测试", code: "002415.SZ", lotSize: 100 }, bars: Array.from({ length: 96 }, (_, i) => ({ end: `bar-${i}` })) } as Dataset;
describe("code experiment input", () => {
  it("reserves warmup and rejects wrong dataset, fractional stock and missing range", () => {
    const spec = codeDefaults(data, "fn on_bar(ctx) { #{side: \"hold\", quantity: 0} }");
    expect(codeError(spec, data)).toBeNull();
    expect(codeError({ ...spec, datasetId: "other" }, data)).toContain("数据集");
    expect(codeError({ ...spec, tradeSize: 101 }, data)).toContain("整手");
    expect(codeError({ ...spec, start: "bar-1" }, data)).toContain("预热");
    expect(codeError({ ...spec, end: "missing" }, data)).toContain("区间");
  });
  it("keeps actual edited code and immutable references in visible context", () => {
    const context = researchContext("海康", { page: "code", mode: "edit", datasetId: "frozen", draft: { source: "用户修改后的代码" }, reportId: "report" });
    expect(context.text).toContain("用户修改后的代码"); expect(context.text).toContain('"datasetId": "frozen"'); expect(context.text).toContain('"reportId": "report"');
    expect(context.page).toBe("code"); expect(context.mode).toBe("edit");
  });
  it("respects board quantity rules and restarts warmup after corporate actions", () => {
    const market = { ...data, security: { ...data.security, code: "688981.SH", lotSize: 1 },
      blockedSessions: ["2026-11-02"], bars: data.bars.map((b,i) => ({...b, session:i < 48 ? "2026-11-02" : "2026-11-03"})) };
    const spec = codeDefaults(market, "fn on_bar(ctx) { #{side: \"hold\", quantity: 0} }");
    expect(spec.start).toBe("bar-78");
    expect(spec.tradeSize).toBe(200);
    expect(codeError({...spec,tradeSize:201},market)).toBeNull();
    expect(codeError({...spec,tradeSize:199},market)).toContain("最低申报");
    expect(codeError({...spec,start:"bar-60"},market)).toContain("除权除息");
    expect(codeDefaults({...market,blockedSessions:["2026-11-03"]},spec.source).start).toBe("");
  });
  it("allows verified distributions across full range but guards unknown initial entitlements", () => {
    const market = { ...data, bars: data.bars.map((b,i) => ({...b, session: i < 48 ? "2026-11-02" : "2026-11-03"})),
      corporateActions: [{id:"cash",recordDate:"2026-11-02",exDate:"2026-11-03",payDate:"2026-11-03",listingDate:null}] } as Dataset;
    const spec = codeDefaults(market, "fn on_bar(ctx) { #{side: \"hold\", quantity: 0} }");
    expect(spec.start).toBe("bar-30");
    expect(codeError(spec,market)).toBeNull();
    expect(codeError({...spec,start:"bar-78"},market)).toContain("起点前");
    expect(codeError({...spec,start:"bar-78",basePosition:0},market)).toBeNull();
    expect(codeError(spec,{...market,blockedSessions:["2026-11-03"]})).toContain("未核实");
  });
});
