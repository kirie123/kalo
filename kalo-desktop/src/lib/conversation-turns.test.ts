import { describe, expect, it } from "vitest";
import type { AssistantEntry, TimelineEntry, ToolGroupEntry } from "./timeline";
import { foldConversationTurns, formatProcessDuration, processStartedAt } from "./conversation-turns";

function assistant(id: string, text: string, extra: Partial<AssistantEntry> = {}): AssistantEntry {
  return { id, kind: "assistant", streaming: false,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1000 }, ...extra };
}
function tool(id = "tool"): ToolGroupEntry {
  return { id, kind: "toolGroup", toolName: "bash", calls: [
    { toolCallId: id, toolName: "bash", args: { command: "echo ok" }, status: "success", startedAt: 2000 },
  ] };
}
const user: TimelineEntry = { id: "user", kind: "user", message: { role: "user", content: "开始", timestamp: 10 } };
const changes: TimelineEntry = { id: "changes", kind: "changes", files: [], totalAdded: 0, totalRemoved: 0 };
const usage = { calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

describe("foldConversationTurns", () => {
  it("folds interleaved progress and tools as one run while preserving the final reply", () => {
    const first = assistant("first", "先检查");
    const progress = assistant("progress", "找到原因，继续修复");
    const final = assistant("final", "已经完成");
    const rows = foldConversationTurns([user, first, tool(), progress, tool("test"), final, changes], false);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "segment", "entry", "entry"]);
    expect(rows[1]).toMatchObject({ id: "first", running: false, entries: [first, tool(), progress, tool("test")] });
    expect(rows[2]).toEqual({ kind: "entry", entry: final });
    expect(rows[3]).toEqual({ kind: "entry", entry: changes });
  });

  it("keeps every progress message visible in the active run and its id stable at settlement", () => {
    const progress = assistant("first", "正在检查");
    const final = assistant("final", "检查结果");
    const live = foldConversationTurns([user, progress, tool(), final], true);
    const done = foldConversationTurns([user, progress, tool(), final], false);
    expect(live[1]).toMatchObject({ kind: "segment", id: "first", running: true, entries: [progress, tool(), final] });
    expect(done[1]).toMatchObject({ id: "first", running: false });
  });

  it("does not present a pre-tool update as a final answer when the run stops without one", () => {
    const rows = foldConversationTurns([assistant("first", "准备开始"), tool()], false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "segment", entries: [assistant("first", "准备开始"), tool()] });
  });

  it("keeps the last progress update in the process if the subsequent response failed", () => {
    const progress = assistant("progress", "正在整理结果");
    const failure = assistant("failure", "", { message: { role: "assistant", content: [], timestamp: 3000, stopReason: "error", errorMessage: "网络断开" } });
    const rows = foldConversationTurns([tool(), progress, failure], false);
    expect(rows[0]).toMatchObject({ kind: "segment", entries: [tool(), progress] });
    expect(rows[1]).toEqual({ kind: "entry", entry: failure });
  });

  it("never treats a toolUse response as the final answer even when its tool block is absent", () => {
    const progress = assistant("progress", "接下来执行命令");
    progress.message.stopReason = "toolUse";
    expect(foldConversationTurns([progress], false)[0]).toMatchObject({ kind: "segment", entries: [progress] });
  });

  it("keeps plain replies outside a process container", () => {
    const final = assistant("final", "你好");
    expect(foldConversationTurns([user, final], false)).toEqual([{ kind: "entry", entry: user }, { kind: "entry", entry: final }]);
  });

  it("splits final thinking from prose without modifying the source or losing usage", () => {
    const final = assistant("final", "结果", { usage });
    final.message.content.unshift({ type: "thinking", thinking: "核实结果" });
    const source = structuredClone(final);
    const rows = foldConversationTurns([final], false);
    expect(rows[0]).toMatchObject({ kind: "segment", id: "final", entries: [{ id: "final:thinking", usage: undefined }] });
    expect(rows[1]).toMatchObject({ kind: "entry", entry: { id: "final", usage, message: { content: [{ type: "text", text: "结果" }] } } });
    expect(final).toEqual(source);
  });

  it.each(["error", "aborted"] as const)("never hides %s messages", (stopReason) => {
    const failure = assistant("failed", "", { message: { role: "assistant", content: [], stopReason, timestamp: 3000 } });
    const rows = foldConversationTurns([assistant("first", "检查中"), tool(), failure], false);
    expect(rows.at(-1)).toEqual({ kind: "entry", entry: failure });
  });

  it("keeps widgets, notices and declared artifacts outside the collapsed process", () => {
    const widget: TimelineEntry = { id: "widget", kind: "widget", summary: { title: "图", widget_code: "<svg />", loading_messages: [], render_mode: "svg" } };
    const artifact: TimelineEntry = { id: "artifact", kind: "artifacts", summary: { items: [], primary: null } };
    const notice: TimelineEntry = { id: "notice", kind: "notice", text: "状态提示" };
    const rows = foldConversationTurns([tool(), widget, assistant("final", "结果"), artifact, notice], false);
    expect(rows.filter((row) => row.kind === "entry").map((row) => row.entry.id)).toEqual(["widget", "final", "artifact", "notice"]);
  });

  it("fences runs at users, changes cards and settled usage records", () => {
    const rows = foldConversationTurns([tool("a"), assistant("a", "完成", { usage }), changes,
      tool("b"), assistant("b", "完成", { usage }), user, tool("c")], true);
    expect(rows.filter((row) => row.kind === "segment").map((row) => [row.id, row.running])).toEqual([
      ["a", false], ["b", false], ["c", true],
    ]);
  });

  it("does not hide a tool error behind a success-looking header", () => {
    const failedTool = tool();
    failedTool.calls[0].status = "error";
    expect(foldConversationTurns([failedTool], false)[0]).toMatchObject({ stats: { error: true } });
  });

  it("supports history pages beginning in the middle of a run", () => {
    const rows = foldConversationTurns([tool(), assistant("final", "历史结果")], false);
    expect(rows.map((row) => row.kind)).toEqual(["segment", "entry"]);
    expect(rows[0]).toMatchObject({ running: false });
  });
});

describe("process time", () => {
  it("ignores the user's waiting time and absent/invalid history timestamps", () => {
    expect(processStartedAt([user, assistant("a", "进度"), tool()])).toBe(1000);
    const missing = assistant("a", "历史");
    missing.message.timestamp = 0;
    expect(processStartedAt([missing])).toBeUndefined();
    missing.message.timestamp = NaN;
    expect(processStartedAt([missing])).toBeUndefined();
  });
  it.each([[0, "0 秒"], [-1000, "0 秒"], [59000, "59 秒"], [64000, "1 分钟 4 秒"], [3661000, "1 小时 1 分钟"]])(
    "formats %s milliseconds", (value, expected) => expect(formatProcessDuration(Number(value))).toBe(expected),
  );
});
