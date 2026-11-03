import { describe, expect, it } from "vitest";
import { strategyExperimentPrompt, strategyIdeaError, strategyIdeaLimit } from "./experiment-request";

describe("natural language experiment request", () => {
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
