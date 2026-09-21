import { describe, expect, it } from "vitest";
import { compactionActivityView, type CompactionActivityItem } from "./subagent-activity";

/**
 * The subagent card's compaction pill: an automatic compaction must read as
 * automatic, a manual one as manual, and both failures must stay visible
 * instead of silently disappearing from the feed.
 *
 * Contract: doc/2026-09-18-子agent压缩气泡.md
 */

function item(fields: Partial<CompactionActivityItem>): CompactionActivityItem {
  return { kind: "compaction", reason: "threshold", status: "done", ...fields };
}

describe("compactionActivityView", () => {
  it("shows the running state while the child compacts", () => {
    expect(compactionActivityView(item({ status: "running" }))).toEqual({ label: "正在压缩上下文…" });
  });

  it("pairs the automatic label with the pre-compaction context size", () => {
    expect(compactionActivityView(item({ tokensBefore: 185_196 }))).toEqual({
      label: "上下文已自动压缩",
      meta: "185K tokens",
    });
  });

  it("drops the meta line when the size is unknown", () => {
    expect(compactionActivityView(item({}))).toEqual({ label: "上下文已自动压缩" });
  });

  it("labels a manual compaction as manual", () => {
    expect(compactionActivityView(item({ reason: "manual" })).label).toBe("上下文已压缩");
  });

  it("reports a cancellation", () => {
    expect(compactionActivityView(item({ status: "failed", aborted: true }))).toEqual({
      label: "上下文压缩已取消",
    });
  });

  it("keeps the failure reason, with a fallback when the engine sent none", () => {
    expect(
      compactionActivityView(item({ status: "failed", errorMessage: "Auto-compaction failed: 502" })).label,
    ).toBe("上下文压缩失败：Auto-compaction failed: 502");
    expect(compactionActivityView(item({ status: "failed" })).label).toBe("上下文压缩失败：未知原因");
  });
});