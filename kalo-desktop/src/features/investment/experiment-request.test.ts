import { describe, expect, it } from "vitest";
import { acceptsStrategyExample, strategyExperimentPrompt, strategyIdeaError, strategyIdeaExample, strategyIdeaLimit } from "./experiment-request";

describe("natural language experiment request", () => {
  it("accepts an example only for an empty draft and plain Tab, preserving navigation and IME", () => {
    expect(acceptsStrategyExample("", { key: "Tab" }, false)).toBe(true);
    for (const text of ["我的策略", " ", strategyIdeaExample]) expect(acceptsStrategyExample(text, { key: "Tab" }, false)).toBe(false);
    for (const event of [{ key: "Enter" }, { key: "Tab", shiftKey: true }, { key: "Tab", ctrlKey: true }, { key: "Tab", altKey: true }, { key: "Tab", metaKey: true }, { key: "Tab", isComposing: true }, { key: "Tab", keyCode: 229 }]) expect(acceptsStrategyExample("", event, false)).toBe(false);
    expect(acceptsStrategyExample("", { key: "Tab" }, true)).toBe(false);
    expect(strategyIdeaError(strategyIdeaExample)).toBeNull();
  });
  it("preserves user conditions and sends an independent execution request without dataset defaults", () => {
    const idea = "海康威视，5分钟KDJ金叉买入100股，死叉卖出100股；已有1000股，不改阈值。";
    const prompt = strategyExperimentPrompt(`  ${idea}\n`);
    expect(prompt.startsWith(`${idea}\n`)).toBe(true);
    expect(prompt).toContain("实际运行回测");
    expect(prompt).toContain("不继承之前会话或面板");
    expect(prompt).not.toContain("datasetId");
    expect(prompt).not.toContain("510300");
  });
  it("rejects empty and oversized ideas while permitting multilingual multiline input", () => {
    expect(() => strategyExperimentPrompt(" \n\t")).toThrow("请先描述");
    expect(strategyIdeaError("中".repeat(strategyIdeaLimit))).toBeNull();
    expect(() => strategyExperimentPrompt("中".repeat(strategyIdeaLimit + 1))).toThrow("字以内");
    expect(strategyExperimentPrompt("KDJ\n买入条件：K > D\n卖出条件：K < D")).toContain("KDJ\n买入条件：K > D\n卖出条件：K < D");
  });
});
