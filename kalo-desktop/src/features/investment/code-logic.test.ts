import { describe, it, expect } from "vitest";
import { codeDefaults, codeError, researchContext } from "./code-logic";
import type { Dataset } from "./code-types";
const data = { id: "frozen", bars: Array.from({ length: 96 }, (_, i) => ({ end: `bar-${i}` })) } as Dataset;
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
    const context = researchContext("海康", { datasetId: "frozen", draft: { source: "用户修改后的代码" }, reportId: "report" });
    expect(context.text).toContain("用户修改后的代码"); expect(context.text).toContain('"datasetId": "frozen"'); expect(context.text).toContain('"reportId": "report"');
  });
});
