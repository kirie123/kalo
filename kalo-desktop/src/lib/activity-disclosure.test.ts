import { describe, expect, it } from "vitest";
import { activitySummary, syncActivityDisclosure } from "./activity-disclosure";
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
