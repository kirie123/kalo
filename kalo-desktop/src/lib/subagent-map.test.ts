import { describe, expect, it } from "vitest";
import {
  agentActivitySummary,
  agentStatusView,
  collectSubagents,
  sameSubagentNodes,
  summarizeSubagents,
  type SubagentNode,
} from "./subagent-map";
import type { TimelineEntry, ToolCallRecord } from "./timeline";

/**
 * The subagent map folds the session's `agent` tool calls into one node per
 * child. The load-bearing rules: identity (childId ?? resume ?? call id),
 * live-vs-settled data, and the ending flags the engine reports.
 *
 * Contract: doc/2026-09-30-子agent活动面板.md
 */

let seq = 0;

function call(fields: Partial<ToolCallRecord>): ToolCallRecord {
  seq++;
  return {
    toolCallId: `call-${seq}`,
    toolName: "agent",
    args: { prompt: "查一下 X" },
    status: "success",
    ...fields,
  };
}

function group(...calls: ToolCallRecord[]): TimelineEntry {
  return { id: `group-${++seq}`, kind: "toolGroup", toolName: "agent", calls };
}

/** A running call: the engine pushes steps/tokens/activity via partialResult. */
function running(partial: Record<string, any>, args: Record<string, any> = { prompt: "查一下 X" }): ToolCallRecord {
  return call({ status: "running", args, partialResult: { details: partial } });
}

/** A settled call: everything lives in result.details. */
function settled(result: Record<string, any>, args: Record<string, any> = { prompt: "查一下 X" }): ToolCallRecord {
  return call({ status: "success", args, result: { details: result } });
}

describe("collectSubagents", () => {
  it("lists a running child keyed on its call id, with live progress", () => {
    const [node] = collectSubagents([
      group(
        running(
          { description: "调研 X", steps: 4, tokens: 12_300, activity: [{ kind: "text", text: "开始" }] },
          { prompt: "查一下 X", description: "调研 X" },
        ),
      ),
    ]);
    expect(node).toMatchObject({
      key: node.toolCallId,
      id: undefined,
      title: "调研 X",
      prompt: "查一下 X",
      status: "running",
      steps: 4,
      tokens: 12_300,
      calls: 1,
    });
    expect(node.activity).toHaveLength(1);
  });

  it("prefers the prompt's first line when the call carries no description", () => {
    const [node] = collectSubagents([
      group(call({ args: { prompt: "先读 AGENTS.md\n再看代码" } })),
    ]);
    expect(node.title).toBe("先读 AGENTS.md");
  });

  it("folds a child's resume calls into one node and keeps the newest totals", () => {
    const nodes = collectSubagents([
      group(settled({ childId: "subagent-1", description: "调研 X", turns: 3, tokens: 10_000 }, { prompt: "查 X" })),
      group(
        settled(
          { childId: "subagent-1", description: "补一层", turns: 5, tokens: 26_000, resumed: true },
          { prompt: "再查 Y", description: "补一层", resume: "subagent-1" },
        ),
      ),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      key: "subagent-1",
      id: "subagent-1",
      title: "补一层",
      prompt: "再查 Y",
      steps: 5,
      tokens: 26_000,
      calls: 2,
    });
  });

  it("keeps a resumed call separate until it settles (identity comes from args.resume)", () => {
    const nodes = collectSubagents([
      group(settled({ childId: "subagent-7", turns: 2, tokens: 5_000 })),
      group(running({ steps: 1, tokens: 900 }, { prompt: "接着干", resume: "subagent-7" })),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "subagent-7", status: "running", steps: 1, calls: 2 });
  });

  it("orders nodes by first spawn", () => {
    const nodes = collectSubagents([
      group(settled({ childId: "subagent-1" })),
      group(settled({ childId: "subagent-2" })),
      group(settled({ childId: "subagent-1", resumed: true }, { resume: "subagent-1" })),
    ]);
    expect(nodes.map((n) => n.key)).toEqual(["subagent-1", "subagent-2"]);
  });

  it("keeps children apart that reused an id after an engine restart", () => {
    // Engine child ids are per-process counters, so a session outliving an
    // engine restart really does contain several `subagent-1` calls with
    // `resumed: false` and different tasks (verified against session files).
    const nodes = collectSubagents([
      group(settled({ childId: "subagent-1", description: "任务甲", turns: 2, tokens: 14_103 }, { prompt: "甲", description: "任务甲" })),
      group(settled({ childId: "subagent-1", description: "任务乙", turns: 3, tokens: 8_285 }, { prompt: "乙", description: "任务乙" })),
      group(settled({ childId: "subagent-1", description: "任务丙", turns: 6, tokens: 10_213 }, { prompt: "丙", description: "任务丙" })),
    ]);
    expect(nodes.map((n) => [n.key, n.id, n.title, n.calls])).toEqual([
      ["subagent-1", "subagent-1", "任务甲", 1],
      ["subagent-1#2", "subagent-1", "任务乙", 1],
      ["subagent-1#3", "subagent-1", "任务丙", 1],
    ]);
  });

  it("resumes the newest node when an id was reused", () => {
    const nodes = collectSubagents([
      group(settled({ childId: "subagent-1", turns: 2, tokens: 1_000 })),
      group(settled({ childId: "subagent-1", turns: 3, tokens: 2_000 })),
      // Matches the engine's own revive rule (newest session file wins).
      group(settled({ childId: "subagent-1", resumed: true, turns: 4, tokens: 3_500 }, { resume: "subagent-1" })),
    ]);
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ key: "subagent-1#2", calls: 2, tokens: 3_500, steps: 4 });
    expect(nodes[0].calls).toBe(1);
  });

  it("maps every ending the engine reports", () => {
    const statuses = collectSubagents([
      group(settled({ childId: "subagent-1", failed: "provider 502" })),
      group(settled({ childId: "subagent-2", stalled: true })),
      group(settled({ childId: "subagent-3", aborted: true })),
      // Parent round aborted before the child answered: no result at all.
      group(call({ status: "error" })),
    ]).map((n) => n.status);
    expect(statuses).toEqual(["failed", "stalled", "aborted", "failed"]);
  });

  it("keeps the previous turn's numbers and feed when the newest call pushed nothing yet", () => {
    const feed = [{ kind: "tool" as const, toolCallId: "t1", name: "grep", label: "TODO", status: "success" as const }];
    const nodes = collectSubagents([
      group(
        settled({
          childId: "subagent-9",
          turns: 4,
          tokens: 21_000,
          activity: feed,
          transcriptPath: "/tmp/subagent-9.md",
        }),
      ),
      // Resume just landed: no partial/result details at all yet.
      group(call({ status: "running", args: { prompt: "接着干", resume: "subagent-9" } })),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      status: "running",
      steps: 4,
      tokens: 21_000,
      calls: 2,
      transcriptPath: "/tmp/subagent-9.md",
    });
    expect(nodes[0].activity).toBe(feed);
  });

  it("carries the failure reason and the transcript path", () => {
    const [node] = collectSubagents([
      group(settled({ childId: "subagent-4", failed: "provider 502", transcriptPath: "/tmp/subagent-4.md" })),
    ]);
    expect(node.errorMessage).toBe("provider 502");
    expect(node.transcriptPath).toBe("/tmp/subagent-4.md");
  });

  it("ignores non-agent tools", () => {
    const nodes = collectSubagents([
      {
        id: "g",
        kind: "toolGroup",
        toolName: "bash",
        calls: [call({ toolName: "bash", args: { command: "ls" } })],
      },
    ]);
    expect(nodes).toEqual([]);
  });
});

describe("summarizeSubagents", () => {
  it("counts totals and running children", () => {
    const nodes = collectSubagents([
      group(running({ steps: 1, tokens: 1 })),
      group(settled({ childId: "subagent-2" })),
      group(settled({ childId: "subagent-3", failed: "boom" })),
    ]);
    expect(summarizeSubagents(nodes)).toEqual({ total: 3, running: 1 });
    expect(summarizeSubagents([])).toEqual({ total: 0, running: 0 });
  });
});

describe("sameSubagentNodes", () => {
  const base = (over: Partial<SubagentNode> = {}): SubagentNode => ({
    key: "subagent-1",
    title: "调研 X",
    prompt: "查 X",
    status: "running",
    steps: 2,
    tokens: 100,
    calls: 1,
    toolCallId: "call-1",
    ...over,
  });

  it("treats equal nodes with different identities as equal", () => {
    expect(sameSubagentNodes([base()], [base()])).toBe(true);
  });

  it("notices progress, status and feed changes", () => {
    expect(sameSubagentNodes([base()], [base({ steps: 3 })])).toBe(false);
    expect(sameSubagentNodes([base()], [base({ status: "done" })])).toBe(false);
    expect(sameSubagentNodes([base()], [base({ activity: [{ kind: "text", text: "hi" }] })])).toBe(false);
  });

  it("compares the activity feed by reference, not by value", () => {
    const feed = [{ kind: "text" as const, text: "hi" }];
    expect(sameSubagentNodes([base({ activity: feed })], [base({ activity: feed })])).toBe(true);
    expect(sameSubagentNodes([base({ activity: feed })], [base({ activity: [...feed] })])).toBe(false);
  });
});

describe("agentStatusView", () => {
  const node = (over: Partial<SubagentNode>): SubagentNode =>
    ({ key: "k", title: "t", prompt: "p", status: "done", calls: 1, toolCallId: "c", ...over }) as SubagentNode;

  it("labels each ending", () => {
    expect(agentStatusView(node({ status: "running" }))).toEqual({ label: "运行中", tone: "running" });
    expect(agentStatusView(node({ status: "done" }))).toEqual({ label: "已完成", tone: "ok" });
    expect(agentStatusView(node({ status: "stalled" }))).toEqual({ label: "卡死中止", tone: "warn" });
    expect(agentStatusView(node({ status: "aborted" }))).toEqual({ label: "已中止", tone: "warn" });
    expect(agentStatusView(node({ status: "failed", errorMessage: "provider 502" }))).toEqual({
      label: "失败：provider 502",
      tone: "danger",
    });
    expect(agentStatusView(node({ status: "failed" }))).toEqual({ label: "失败", tone: "danger" });
  });
});

describe("agentActivitySummary", () => {
  const node = (activity: SubagentNode["activity"]): SubagentNode =>
    ({ key: "k", title: "t", prompt: "p", status: "running", calls: 1, toolCallId: "c", activity }) as SubagentNode;

  it("summarizes the newest feed entry", () => {
    expect(agentActivitySummary(node([{ kind: "tool", toolCallId: "t", name: "grep", label: "TODO", status: "running" }]))).toBe(
      "grep TODO",
    );
    expect(agentActivitySummary(node([{ kind: "text", text: "第一段\n第二段" }]))).toBe("第一段 第二段");
    expect(agentActivitySummary(node([{ kind: "compaction", reason: "threshold", status: "running" }]))).toBe(
      "正在压缩上下文…",
    );
  });

  it("returns nothing when the child never emitted a feed", () => {
    expect(agentActivitySummary(node(undefined))).toBeUndefined();
    expect(agentActivitySummary(node([]))).toBeUndefined();
  });
});