import { describe, expect, it } from "vitest";
import { activityHeading, activitySummary, syncActivityDisclosure } from "./activity-disclosure";
import { segmentStats } from "./work-segment";

describe("activity disclosure", () => {
  it("keeps manual choices during live updates and after settlement", () => {
    const collapsed = { running: true, open: false };
    expect(syncActivityDisclosure(collapsed, true)).toBe(collapsed);
    const expanded = { running: false, open: true };
    expect(syncActivityDisclosure(expanded, false)).toBe(expanded);
  });
  it("auto-folds at settlement and reopens if the same activity resumes", () => {
    expect(syncActivityDisclosure({ running: true, open: true }, false)).toEqual({ running: false, open: false });
    expect(syncActivityDisclosure({ running: false, open: false }, true)).toEqual({ running: true, open: true });
  });
});

describe("activity summary", () => {
  it("combines categories and counts without leaking unknown ids", () => {
    const stats = { ...segmentStats([]), tools: [{ name: "edit", count: 2 }, { name: "bash", count: 3 }, { name: "mcp_hidden", count: 1 }] };
    expect(activitySummary(stats).label).toBe("编辑了 2 个文件，执行了 3 条命令，调用了 1 次其他工具");
  });
  it("bounds the heading while retaining the complete summary", () => {
    const stats = { ...segmentStats([]), tools: ["read", "write", "bash", "grep", "agent"].map((name) => ({ name, count: 1 })) };
    const summary = activitySummary(stats);
    expect(summary.label).toContain("等 5 类操作");
    expect(summary.label).not.toContain("派生");
    expect(summary.full).toContain("派生了 1 个子 agent");
    expect(activitySummary(segmentStats([])).label).toBe("思考过程");
  });
});

describe("activity heading", () => {
  const stats = { ...segmentStats([]), tools: [{ name: "bash", count: 4 }] };
  it("shows elapsed time while running and only the frozen duration after completion", () => {
    expect(activityHeading(stats, true, 73000)).toBe("执行了 4 条命令 · 已运行 1 分钟 13 秒");
    expect(activityHeading(stats, false, 73000)).toBe("用时 1 分钟 13 秒");
    expect(activityHeading(stats, false, 0)).toBe("用时 0 秒");
  });
  it.each([undefined, -1, NaN, Infinity])("does not invent timing for missing or invalid duration %s", (elapsed) => {
    expect(activityHeading(stats, false, elapsed)).toBe("任务过程");
    expect(activityHeading(stats, true, elapsed)).toBe("执行了 4 条命令");
  });
});
