import { describe, expect, it } from "vitest";
import type { AssistantEntry, TimelineEntry, ToolCallRecord, ToolGroupEntry } from "./timeline";
import { foldWorkSegments, isProcessEntry, sameSegmentEntries, segmentStats } from "./work-segment";

let seq = 0;
const id = () => `e${++seq}`;

function thinking(text = "think"): AssistantEntry {
  return {
    id: id(),
    kind: "assistant",
    streaming: false,
    message: { role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp: 0 },
  };
}

function answer(text = "done"): AssistantEntry {
  return {
    id: id(),
    kind: "assistant",
    streaming: false,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 },
  };
}

function tools(name: string, calls: Partial<ToolCallRecord>[]): ToolGroupEntry {
  return {
    id: id(),
    kind: "toolGroup",
    toolName: name,
    calls: calls.map((c, i) => ({
      toolCallId: `${name}-${i}`,
      toolName: name,
      args: {},
      status: "success",
      ...c,
    })) as ToolCallRecord[],
  };
}

const user = (): TimelineEntry => ({
  id: id(),
  kind: "user",
  message: { role: "user", content: "hi", timestamp: 0 },
});

describe("isProcessEntry", () => {
  it("treats thinking-only / tool-call-only assistant messages as process", () => {
    expect(isProcessEntry(thinking())).toBe(true);
    expect(
      isProcessEntry({
        id: id(),
        kind: "assistant",
        streaming: true,
        message: { role: "assistant", content: [], timestamp: 0 },
      }),
    ).toBe(true);
  });

  it("keeps prose, errors and interrupts out of segments", () => {
    expect(isProcessEntry(answer())).toBe(false);
    expect(
      isProcessEntry({
        id: id(),
        kind: "assistant",
        streaming: false,
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom", timestamp: 0 },
      }),
    ).toBe(false);
    expect(
      isProcessEntry({
        id: id(),
        kind: "assistant",
        streaming: false,
        message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 0 },
      }),
    ).toBe(false);
  });

  it("never folds user, changes or compaction entries", () => {
    expect(isProcessEntry(user())).toBe(false);
    expect(
      isProcessEntry({ id: id(), kind: "changes", files: [], totalAdded: 0, totalRemoved: 0 } as TimelineEntry),
    ).toBe(false);
    expect(isProcessEntry({ id: id(), kind: "compaction", summary: "s", auto: true })).toBe(false);
  });
});

describe("foldWorkSegments", () => {
  it("groups a consecutive run and passes everything else through", () => {
    const u = user();
    const t1 = thinking();
    const g1 = tools("read", [{}]);
    const a = answer();
    const rows = foldWorkSegments([u, t1, g1, a]);

    expect(rows.map((r) => r.kind)).toEqual(["entry", "segment", "entry"]);
    const seg = rows[1] as Extract<(typeof rows)[number], { kind: "segment" }>;
    expect(seg.id).toBe(t1.id);
    expect(seg.entries).toEqual([t1, g1]);
  });

  it("leaves a lone process entry unwrapped", () => {
    const rows = foldWorkSegments([user(), thinking(), answer()]);
    expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "entry"]);
  });

  it("cuts the segment at prose and starts a new one after it", () => {
    const rows = foldWorkSegments([
      thinking(),
      tools("read", [{}]),
      answer(),
      thinking(),
      tools("bash", [{}]),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["segment", "entry", "segment"]);
  });

  it("folds a trailing run that has no answer yet (still running)", () => {
    const rows = foldWorkSegments([user(), thinking(), tools("bash", [{ status: "running" }])]);
    expect(rows.map((r) => r.kind)).toEqual(["entry", "segment"]);
    expect((rows[1] as any).stats.running).toBe(true);
  });

  it("keeps segment id stable while the run grows", () => {
    const t1 = thinking();
    const g1 = tools("read", [{}]);
    const first = foldWorkSegments([t1, g1])[0] as any;
    const second = foldWorkSegments([t1, g1, tools("bash", [{}])])[0] as any;
    expect(second.id).toBe(first.id);
  });
});

describe("segmentStats", () => {
  it("counts steps, thoughts and per-tool calls in first-appearance order", () => {
    const stats = segmentStats([
      thinking(),
      tools("read", [{ args: { path: "a.ts" } }, { args: { path: "b.ts" } }]),
      thinking(),
      tools("bash", [{ args: { command: "npm test" } }]),
      tools("read", [{ args: { path: "c.ts" } }]),
    ]);
    expect(stats.thoughts).toBe(2);
    expect(stats.steps).toBe(6);
    expect(stats.tools).toEqual([
      { name: "read", count: 3 },
      { name: "bash", count: 1 },
    ]);
    expect(stats.lastLabel).toBe("读取 c.ts");
  });

  it("propagates running and error state from the calls", () => {
    expect(segmentStats([tools("bash", [{ status: "running" }])]).running).toBe(true);
    expect(segmentStats([tools("bash", [{ status: "error" }])]).error).toBe(true);
    expect(segmentStats([tools("bash", [{}])]).running).toBe(false);
  });
});

describe("sameSegmentEntries", () => {
  it("compares element references, not array identity", () => {
    const a = thinking();
    const b = tools("read", [{}]);
    expect(sameSegmentEntries([a, b], [a, b])).toBe(true);
    expect(sameSegmentEntries([a, b], [a])).toBe(false);
    expect(sameSegmentEntries([a, b], [a, { ...b }])).toBe(false);
  });
});
