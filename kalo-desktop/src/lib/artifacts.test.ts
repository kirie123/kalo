import { describe, expect, it } from "vitest";
import { handleSpecialToolResult, parseArtifacts, sessionArtifacts } from "./artifacts";
import { resolvePanelMemory } from "./file-panel-memory";
import type { ToolCallRecord } from "./timeline";

function makeRec(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    toolCallId: "tc1",
    toolName: "present_files",
    args: {},
    status: "success",
    result: {
      content: [],
      details: {
        artifacts: [
          { kind: "file", path: "/out/report.html", name: "report.html", fileKind: "html", primary: true },
          { kind: "file", path: "/out/data.csv", name: "data.csv", fileKind: "text", primary: false },
        ],
      },
    },
    ...overrides,
  };
}

describe("parseArtifacts", () => {
  it("returns null for non-present_files tools", () => {
    expect(parseArtifacts({ ...makeRec(), toolName: "write" })).toBeNull();
  });

  it("returns null on error status", () => {
    expect(parseArtifacts({ ...makeRec(), status: "error" })).toBeNull();
  });

  it("returns null when details is missing", () => {
    expect(parseArtifacts({ ...makeRec(), result: { content: [] } })).toBeNull();
  });

  it("returns null when artifacts is empty after filtering", () => {
    const rec = makeRec();
    rec.result.details.artifacts = [{ nope: true }];
    expect(parseArtifacts(rec)).toBeNull();
  });

  it("parses valid details and identifies the primary", () => {
    const summary = parseArtifacts(makeRec());
    expect(summary).not.toBeNull();
    expect(summary!.items).toHaveLength(2);
    expect(summary!.primary?.name).toBe("report.html");
  });

  it("carries explanation when present", () => {
    const rec = makeRec();
    rec.result.details.explanation = "本次报告";
    expect(parseArtifacts(rec)!.explanation).toBe("本次报告");
  });

  it("primary is null when no item has primary: true", () => {
    const rec = makeRec();
    rec.result.details.artifacts = [
      { kind: "file", path: "/out/a.txt", name: "a.txt", primary: false },
    ];
    const s = parseArtifacts(rec);
    expect(s!.primary).toBeNull();
  });
});

describe("sessionArtifacts", () => {
  it("aggregates all present_files calls, later path wins", () => {
    const first = makeRec();
    const second = makeRec();
    second.toolCallId = "tc2";
    second.result.details.artifacts = [
      { kind: "file", path: "/out/report.html", name: "report.html", fileKind: "html", primary: true, bytes: 9999 },
      { kind: "url", path: "https://example.com/doc", name: "doc", primary: false },
    ];
    const list = sessionArtifacts([first, second]);
    // report.html should appear once, with bytes: 9999 (second declaration wins)
    expect(list.filter((a) => a.path === "/out/report.html")).toHaveLength(1);
    expect(list.find((a) => a.path === "/out/report.html")?.bytes).toBe(9999);
    // data.csv from first, doc URL from second
    expect(list.some((a) => a.path === "/out/data.csv")).toBe(true);
    expect(list.some((a) => a.path === "https://example.com/doc")).toBe(true);
  });

  it("skips non-present_files records", () => {
    const notArtifact: ToolCallRecord = { toolCallId: "t", toolName: "write", args: {}, status: "success" };
    expect(sessionArtifacts([notArtifact])).toHaveLength(0);
  });
});

describe("handleSpecialToolResult — present_files", () => {
  const noop = { setTodos: () => {}, pushArtifacts: () => {} };

  it("calls pushArtifacts with the parsed summary", () => {
    const rec = makeRec();
    let captured: unknown = null;
    handleSpecialToolResult(
      rec,
      { setTodos: () => {}, pushArtifacts: (s) => { captured = s; } },
      { uid: "uid-parse", cwd: "/out" },
    );
    expect(captured).not.toBeNull();
    expect((captured as any).primary?.name).toBe("report.html");
  });

  it("does not call pushArtifacts on error status", () => {
    const rec = makeRec({ status: "error" });
    let called = false;
    handleSpecialToolResult(
      rec,
      { setTodos: () => {}, pushArtifacts: () => { called = true; } },
      { uid: "uid-error", cwd: "/out" },
    );
    expect(called).toBe(false);
  });

  it("queues the primary for auto-open in the session that declared it", () => {
    handleSpecialToolResult(makeRec(), noop, { uid: "uid-owner", cwd: "/out" });
    expect(resolvePanelMemory("uid-owner", "/out").pendingArtifact).toEqual({
      name: "report.html",
      path: "/out/report.html",
    });
  });

  it("leaves another session's file area untouched", () => {
    handleSpecialToolResult(makeRec(), noop, { uid: "uid-owner-b", cwd: "/out" });
    expect(resolvePanelMemory("uid-bystander", "/out").pendingArtifact).toBeNull();
  });

  it("drops URLs and files the engine could not stat", () => {
    const artifacts = (items: unknown[]) => makeRec({ result: { content: [], details: { artifacts: items } } });
    handleSpecialToolResult(
      artifacts([{ kind: "url", path: "https://x/y", name: "y", primary: true }]),
      noop,
      { uid: "uid-url", cwd: "/out" },
    );
    expect(resolvePanelMemory("uid-url", "/out").pendingArtifact).toBeNull();
    handleSpecialToolResult(
      artifacts([{ kind: "file", path: "/out/gone.md", name: "gone.md", primary: true, missing: true }]),
      noop,
      { uid: "uid-missing", cwd: "/out" },
    );
    expect(resolvePanelMemory("uid-missing", "/out").pendingArtifact).toBeNull();
  });
});
