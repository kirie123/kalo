import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "./timeline";
import { groupTitle, rowLabel, toolChips } from "./tool-labels";

function rec(toolName: string, args: Record<string, unknown> = {}): ToolCallRecord {
  return { toolCallId: `${toolName}-1`, toolName, args, status: "success" };
}

describe("groupTitle", () => {
  it("names built-in tools by what they did", () => {
    expect(groupTitle("read", 3)).toBe("读取了 3 个文件");
    expect(groupTitle("bash", 2)).toBe("执行了 2 条命令");
    expect(groupTitle("job_list", 1)).toBe("查看了 1 次后台任务");
    expect(groupTitle("web_fetch", 2)).toBe("抓取了 2 个网页");
  });

  it("falls back to a generic phrase for unmapped tools, never the raw id", () => {
    expect(groupTitle("mcp_github_create_issue", 2)).toBe("调用了 2 次其他工具");
    expect(groupTitle("mcp_github_create_issue", 2)).not.toContain("mcp");
  });
});

describe("toolChips", () => {
  it("keeps first-appearance order and sums counts per tool", () => {
    const chips = toolChips([
      { name: "read", count: 2 },
      { name: "bash", count: 1 },
      { name: "read", count: 1 },
    ]);
    expect(chips.map((c) => c.label)).toEqual(["读取了 3 个文件", "执行了 1 条命令"]);
  });

  it("merges tools that read the same, e.g. glob and find", () => {
    const chips = toolChips([
      { name: "glob", count: 2 },
      { name: "read", count: 1 },
      { name: "find", count: 3 },
    ]);
    expect(chips.map((c) => c.label)).toEqual(["查找了 5 次", "读取了 1 个文件"]);
    expect(chips[0].count).toBe(5);
  });

  it("merges every unmapped tool into one chip", () => {
    const chips = toolChips([
      { name: "mcp_a_foo", count: 1 },
      { name: "mcp_b_bar", count: 2 },
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe("调用了 3 次其他工具");
  });

  it("gives each chip a stable key derived from its label", () => {
    const chips = toolChips([{ name: "read", count: 1 }]);
    expect(chips[0].key).toBe("读取|个文件");
  });
});

describe("rowLabel", () => {
  it("names the target of built-in calls", () => {
    expect(rowLabel(rec("read", { path: "src/main.ts" }))).toBe("读取 src/main.ts");
    expect(rowLabel(rec("bash", { command: "npm test" }))).toBe("npm test");
    expect(rowLabel(rec("find", { pattern: "**/*.rs" }))).toBe("查找 **/*.rs");
    expect(rowLabel(rec("web_fetch", { url: "https://example.com" }))).toBe("抓取 https://example.com");
    expect(rowLabel(rec("use_skill", { name: "math" }))).toBe("加载 math");
    expect(rowLabel(rec("memory_search", { query: "偏好 写作" }))).toBe("检索 偏好 写作");
    expect(rowLabel(rec("job_output", { job_id: "gateway-3" }))).toBe("读取任务 gateway-3 的输出");
    expect(rowLabel(rec("show_widget", { title: "组合收益曲线" }))).toBe("渲染 组合收益曲线");
    expect(rowLabel(rec("present_files", { files: ["a.html", "b.png"] }))).toBe("呈现 2 个产物");
  });

  it("keeps the id only for unmapped tools, where it is the only identifier", () => {
    expect(rowLabel(rec("mcp_notion_search"))).toBe("mcp_notion_search");
  });
});
