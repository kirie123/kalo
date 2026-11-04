import { describe, expect, it } from "vitest";
import type { AssistantEntry, TimelineEntry, ToolGroupEntry } from "./timeline";
import { foldConversationTurns, formatProcessDuration, processStartedAt } from "./conversation-turns";

function assistant(id: string, text: string, extra: Partial<AssistantEntry> = {}): AssistantEntry {
  return { id, kind: "assistant", streaming: false,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1000 }, ...extra };
}
function tool(id = "tool", status: "success" | "running" | "error" = "success"): ToolGroupEntry {
  return { id, kind: "toolGroup", toolName: "bash", calls: [
    { toolCallId: id, toolName: "bash", args: { command: "echo ok" }, status, startedAt: 2000 },
  ] };
}
function thought(id = "thought"): AssistantEntry {
  return assistant(id, "", { message: { role: "assistant", content: [{ type: "thinking", thinking: "检查结果" }], timestamp: 1500 } });
}
const user: TimelineEntry = { id: "user", kind: "user", message: { role: "user", content: "开始", timestamp: 10 } };
const changes: TimelineEntry = { id: "changes", kind: "changes", files: [], totalAdded: 0, totalRemoved: 0 };
const usage = { calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

describe("foldConversationTurns", () => {
  it("keeps intermediate prose, tools and thinking in one settled process", () => {
    const first = assistant("first", "先检查");
    const progress = assistant("progress", "找到原因，继续修复");
    const final = assistant("final", "已经完成", { usage });
    const process = [first, tool(), thought(), progress, tool("test")];
    const source = [user, ...process, final, changes];
    const original = structuredClone(source);
    const rows = foldConversationTurns(source, false);
    expect(rows.map(row => row.kind)).toEqual(["entry", "segment", "entry", "entry"]);
    expect(rows[1]).toMatchObject({ id: "first", entries: process, running: false, startedAt: 1000 });
    expect(rows[2]).toEqual({ kind: "entry", entry: final });
    expect(source).toEqual(original);
  });

  it("stays expanded through prose updates and folds only when the run settles", () => {
    const progress = assistant("progress", "下一步", { streaming: true });
    const active = [tool("tool", "running"), progress, tool("next")];
    expect(foldConversationTurns(active, true)).toMatchObject([
      { kind: "segment", id: "tool", running: true, entries: active },
    ]);
    const final = assistant("final", "最终结果", { usage });
    const settled = foldConversationTurns([...active, final], true);
    expect(settled[0]).toMatchObject({ id: "tool", running: false, entries: active });
    expect(settled[1]).toEqual({ kind: "entry", entry: final });
  });

  it("keeps streaming text in the process until completion without inferring finality", () => {
    const text = assistant("text", "正在生成", { streaming: true });
    expect(foldConversationTurns([text], true)[0]).toMatchObject({ kind: "segment", entries: [text], running: true });
    expect(foldConversationTurns([{ ...text, streaming: false }], false)[0].kind).toBe("entry");
  });

  it("does not promote commentary when the run ends with a tool", () => {
    const progress = assistant("progress", "开始检查");
    expect(foldConversationTurns([progress, tool()], false)).toMatchObject([
      { kind: "segment", entries: [progress, tool()], running: false },
    ]);
    progress.message.stopReason = "toolUse";
    expect(foldConversationTurns([progress], false)[0].kind).toBe("segment");
  });

  it("omits empty placeholders and empty tool groups", () => {
    expect(foldConversationTurns([assistant("empty", " "), { ...tool(), calls: [] }], true)).toEqual([]);
    expect(foldConversationTurns([assistant("empty", ""), tool()], true)[0]).toMatchObject({ id: "tool" });
  });

  it("moves final thinking into the process without mutating or duplicating the answer", () => {
    const final = assistant("final", "结果", { usage });
    final.message.content.unshift({ type: "thinking", thinking: "核实" });
    const source = structuredClone(final);
    const rows = foldConversationTurns([tool(), final], false);
    expect(rows[0]).toMatchObject({ entries: [tool(), { usage: undefined, message: { content: [{ type: "thinking" }] } }] });
    expect(rows[1]).toMatchObject({ entry: { usage, message: { content: [{ type: "text", text: "结果" }] } } });
    expect(final).toEqual(source);
  });

  it("retains a usage-only footer and hides its thinking", () => {
    const rows = foldConversationTurns([{ ...thought(), usage }], false);
    expect(rows[0]).toMatchObject({ kind: "segment", entries: [{ usage: undefined }] });
    expect(rows[1]).toMatchObject({ kind: "entry", entry: { usage, message: { content: [] } } });
  });

  it("keeps artifacts and widgets mounted outside a single process", () => {
    const artifacts: TimelineEntry = { id: "artifacts", kind: "artifacts", summary: { items: [], primary: null } };
    const widget: TimelineEntry = { id: "widget", kind: "widget", summary: { title: "图", widget_code: "<svg />", loading_messages: [], render_mode: "svg" } };
    const final = assistant("final", "结果", { usage });
    const rows = foldConversationTurns([tool(), artifacts, assistant("progress", "继续"), widget, tool("next"), final], false);
    expect(rows.map(row => row.kind)).toEqual(["segment", "entry", "entry", "entry"]);
    expect(rows.slice(1)).toEqual([artifacts, widget, final].map(entry => ({ kind: "entry", entry })));
  });

  it("hides successful presentation calls but retains failed tool details", () => {
    const present = tool("present");
    present.calls[0].toolName = "present_files";
    expect(foldConversationTurns([present], false)).toEqual([]);
    present.calls[0].status = "error";
    expect(foldConversationTurns([present], false)[0]).toMatchObject({ kind: "segment", stats: { error: true }, entries: [present] });
  });

  it("includes retries, notices and compaction without breaking the process", () => {
    const details: TimelineEntry[] = [tool(),
      { id: "retry", kind: "retry", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "重连", done: { success: true } },
      { id: "notice", kind: "notice", text: "继续运行" },
      { id: "compact", kind: "compaction", summary: "摘要", auto: true }, tool("next")];
    expect(foldConversationTurns([...details, assistant("final", "完成")], false)[0]).toMatchObject({ kind: "segment", entries: details });
  });

  it.each(["error", "aborted"] as const)("retains terminal %s without presenting commentary as the result", stopReason => {
    const failure = assistant("failure", "", { message: { role: "assistant", content: [], stopReason, timestamp: 3000 } });
    const rows = foldConversationTurns([assistant("progress", "检查"), tool(), failure], false);
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe("segment");
    expect(rows[1]).toEqual({ kind: "entry", entry: failure });
  });

  it("folds recovered assistant failures with the rest of the process", () => {
    const failed = assistant("failed", "", { retriedError: true, message: { role: "assistant", content: [], stopReason: "error", timestamp: 1000 } });
    const final = assistant("final", "重试成功", { usage });
    expect(foldConversationTurns([failed, tool(), final], false)[0]).toMatchObject({ entries: [failed, tool()] });
  });

  it("separates user turns, settled autonomous runs and change summaries", () => {
    const rows = foldConversationTurns([tool("a"), assistant("final-a", "完成", { usage }), changes,
      tool("b"), assistant("final-b", "完成", { usage }), user, tool("c")], true);
    expect(rows.filter(row => row.kind === "segment").map(row => [row.id, row.running])).toEqual([
      ["a", false], ["b", false], ["c", true],
    ]);
  });

  it("rebuilds a completed history turn as one collapsed process with its final answer", () => {
    const final = assistant("final", "历史结果");
    const rows = foldConversationTurns([tool(), assistant("progress", "继续"), tool("next"), final], false);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "segment", id: "tool", running: false });
    expect(rows[1]).toEqual({ kind: "entry", entry: final });
  });
});

describe("process time", () => {
  it("ignores user waiting time and absent/invalid history timestamps", () => {
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
