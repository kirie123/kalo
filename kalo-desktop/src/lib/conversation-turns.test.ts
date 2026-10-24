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
  it("folds adjacent tools but keeps every progress message in its original place", () => {
    const first = assistant("first", "先检查");
    const progress = assistant("progress", "找到原因，继续修复");
    const final = assistant("final", "已经完成");
    const rows = foldConversationTurns([user, first, tool(), tool("read"), progress, tool("test"), final, changes], false);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "entry", "segment", "entry", "segment", "entry", "entry"]);
    expect(rows[2]).toMatchObject({ id: "tool", running: false, entries: [tool(), tool("read")] });
    expect(rows[3]).toEqual({ kind: "entry", entry: progress });
    expect(rows[5]).toEqual({ kind: "entry", entry: final });
  });

  it("auto-folds completed activity when prose starts while leaving the tail active", () => {
    const timeline = [user, tool(), assistant("progress", "下一步"), tool("test")];
    const rows = foldConversationTurns(timeline, true);
    expect(rows[1]).toMatchObject({ id: "tool", running: false });
    expect(rows[2]).toMatchObject({ kind: "entry", entry: { id: "progress" } });
    expect(rows[3]).toMatchObject({ id: "test", running: true });
    expect(foldConversationTurns(timeline, false)[3]).toMatchObject({ id: "test", running: false });
  });

  it("keeps concurrent running tools visible when prose arrives", () => {
    const timeline = [tool("parallel", "running"), assistant("progress", "继续核实")];
    expect(foldConversationTurns(timeline, true)[0]).toMatchObject({ running: true });
    expect(foldConversationTurns(timeline, false)[0]).toMatchObject({ running: false });
  });

  it("ignores empty placeholders without splitting activity or changing its id", () => {
    const placeholder = assistant("placeholder", "");
    const rows = foldConversationTurns([placeholder, tool(), placeholder, tool("next")], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "tool", entries: [tool(), tool("next")], running: true });
    expect(foldConversationTurns([assistant("empty", " ")], true)).toEqual([]);
    expect(foldConversationTurns([{ ...tool(), calls: [] }], false)).toEqual([]);
  });

  it("keeps prose visible even when it announces a tool or is still streaming", () => {
    const progress = assistant("progress", "接下来执行命令", { streaming: true });
    progress.message.stopReason = "toolUse";
    expect(foldConversationTurns([progress], true)).toEqual([{ kind: "entry", entry: progress }]);
  });

  it("groups thinking-only activity without moving mixed text/thinking blocks", () => {
    const mixed = assistant("mixed", "结果", { usage });
    mixed.message.content.push({ type: "thinking", thinking: "补充核实" }, { type: "text", text: "补充结果" });
    const source = structuredClone(mixed);
    const rows = foldConversationTurns([thought(), tool(), mixed], false);
    expect(rows[0]).toMatchObject({ kind: "segment", id: "thought", entries: [thought(), tool()] });
    expect(rows[1]).toEqual({ kind: "entry", entry: mixed });
    expect(mixed).toEqual(source);
  });

  it("retains usage-only footers without duplicating their thinking", () => {
    const last = { ...thought(), usage };
    const source = structuredClone(last);
    const rows = foldConversationTurns([last], false);
    expect(rows[0]).toMatchObject({ kind: "segment", entries: [{ usage: undefined }] });
    expect(rows[1]).toMatchObject({ kind: "entry", entry: { usage, message: { content: [] } } });
    expect(last).toEqual(source);
  });

  it.each(["error", "aborted"] as const)("never hides %s messages", (stopReason) => {
    const failure = assistant("failed", "", { message: { role: "assistant", content: [], stopReason, timestamp: 3000 } });
    expect(foldConversationTurns([tool(), failure], false).at(-1)).toEqual({ kind: "entry", entry: failure });
  });

  it("does not merge across outputs, retries, notices or compression", () => {
    const boundaries: TimelineEntry[] = [
      { id: "widget", kind: "widget", summary: { title: "图", widget_code: "<svg />", loading_messages: [], render_mode: "svg" } },
      { id: "artifact", kind: "artifacts", summary: { items: [], primary: null } },
      { id: "notice", kind: "notice", text: "状态提示" },
      { id: "retry", kind: "retry", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "重连" },
      { id: "compact", kind: "compaction", summary: "摘要", auto: true },
    ];
    for (const boundary of boundaries) {
      const rows = foldConversationTurns([tool("before"), boundary, tool("after")], false);
      expect(rows.map((row) => row.kind)).toEqual(["segment", "entry", "segment"]);
      expect(rows[1]).toEqual({ kind: "entry", entry: boundary });
    }
  });

  it("fences activity at users, changes cards and settled usage records", () => {
    const rows = foldConversationTurns([tool("a", "running"), assistant("a", "完成", { usage }), changes,
      tool("b"), assistant("b", "完成", { usage }), user, tool("c")], true);
    expect(rows.filter((row) => row.kind === "segment").map((row) => [row.id, row.running])).toEqual([
      ["a", false], ["b", false], ["c", true],
    ]);
  });

  it("flags tool errors in the summary and leaves the source unchanged", () => {
    const timeline = [tool("failed", "error"), tool("next")];
    const source = structuredClone(timeline);
    expect(foldConversationTurns(timeline, false)[0]).toMatchObject({ stats: { error: true }, entries: timeline });
    expect(timeline).toEqual(source);
  });

  it("supports history pages inside activity and stable ids as activity grows", () => {
    expect(foldConversationTurns([tool(), assistant("final", "历史结果")], false)[0]).toMatchObject({ id: "tool", running: false });
    expect(foldConversationTurns([tool()], true)[0]).toMatchObject({ id: "tool" });
    expect(foldConversationTurns([tool(), tool("next")], false)[0]).toMatchObject({ id: "tool" });
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
