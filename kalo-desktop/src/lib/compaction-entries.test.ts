import { beforeEach, describe, expect, it } from "vitest";
import type { CompactionEntry, NoticeEntry, TimelineEntry } from "./timeline";
import { pushCompactingNotice, settleCompaction, type CompactionEnd } from "./compaction-entries";

function end(partial: Partial<CompactionEnd>): CompactionEnd {
  return { aborted: false, ...partial };
}

let seq = 1;
const nextId = () => `n-${seq++}`;

beforeEach(() => {
  seq = 1;
});

describe("pushCompactingNotice", () => {
  it("appends the running notice", () => {
    const t: TimelineEntry[] = [];
    pushCompactingNotice(t, "id1");
    expect(t).toEqual([{ id: "id1", kind: "notice", text: "正在压缩上下文…" }]);
  });
});

describe("settleCompaction", () => {
  it("replaces the running notice in place with a bubble when a summary exists", () => {
    const t: TimelineEntry[] = [{ id: "run", kind: "notice", text: "正在压缩上下文…" }, { id: "later", kind: "notice", text: "x" }];
    settleCompaction(t, "run", end({ reason: "threshold", result: { summary: "## Goal\nsummary", tokensBefore: 900 } }), nextId);
    expect(t).toHaveLength(2);
    const bubble = t[0] as CompactionEntry;
    expect(bubble.kind).toBe("compaction");
    expect(bubble.summary).toBe("## Goal\nsummary");
    expect(bubble.auto).toBe(true);
    expect(bubble.tokensBefore).toBe(900);
    expect(t[1]).toEqual({ id: "later", kind: "notice", text: "x" });
  });

  it("marks manual compaction as not auto", () => {
    const t: TimelineEntry[] = [];
    settleCompaction(t, null, end({ reason: "manual", result: { summary: "s" } }), nextId);
    expect((t[0] as CompactionEntry).auto).toBe(false);
  });

  it("keeps the notice shape and updates its text when the compaction failed", () => {
    const t: TimelineEntry[] = [];
    settleCompaction(t, null, end({ errorMessage: "model 500" }), nextId);
    expect(t[0]).toEqual({ id: "n-1", kind: "notice", text: "上下文压缩失败：model 500" });
  });

  it("shows the cancelled text when aborted", () => {
    const t: TimelineEntry[] = [];
    settleCompaction(t, null, end({ aborted: true }), nextId);
    expect(t[0]).toEqual({ id: "n-1", kind: "notice", text: "上下文压缩已取消" });
  });

  it("falls back to a plain notice when a success carries no summary", () => {
    const t: TimelineEntry[] = [];
    settleCompaction(t, null, end({ result: {} }), nextId);
    expect(t[0]).toEqual({ id: "n-1", kind: "notice", text: "上下文已压缩" });
  });

  it("appends at the tail when the running notice is gone", () => {
    const t: TimelineEntry[] = [{ id: "other", kind: "notice", text: "x" }];
    settleCompaction(t, "missing", end({ result: { summary: "s" } }), nextId);
    expect(t).toHaveLength(2);
    expect((t[1] as CompactionEntry).kind).toBe("compaction");
  });

  it("replaces a running notice for the failure path too", () => {
    const t: TimelineEntry[] = [{ id: "run", kind: "notice", text: "正在压缩上下文…" }];
    settleCompaction(t, "run", end({ errorMessage: "boom" }), nextId);
    const n = t[0] as NoticeEntry;
    expect(n.kind).toBe("notice");
    expect(n.text).toContain("boom");
  });
});
