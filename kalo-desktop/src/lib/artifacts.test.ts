import { describe, expect, it } from "vitest";
import { foldRunArtifacts, handleSpecialToolResult, mergeArtifactSummaries, parseArtifacts, sessionArtifacts } from "./artifacts";
import type { ArtifactItem } from "./artifacts";
import { resolvePanelMemory } from "./file-panel-memory";
import type { ArtifactsEntry, ChangesEntry, TimelineEntry, UserEntry } from "./timeline";
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

// ---------------------------------------------------------------------------
// End-of-run fold: a run's deliverables ride in its changes card
// ---------------------------------------------------------------------------

function artEntry(id: string, items: Array<Partial<ArtifactItem> & { path: string }>, explanation?: string): ArtifactsEntry {
  const full = items.map((i) => ({ kind: "file" as const, name: i.path.split("/").pop()!, primary: false, ...i }));
  return {
    id,
    kind: "artifacts",
    summary: { items: full, primary: full.find((i) => i.primary) ?? null, explanation },
  };
}

function changesEntry(id: string): ChangesEntry {
  return { id, kind: "changes", files: [], totalAdded: 3, totalRemoved: 1 };
}

function userEntry(id: string): UserEntry {
  return { id, kind: "user", message: { role: "user", content: "hi", timestamp: 0 } };
}

describe("mergeArtifactSummaries", () => {
  it("returns null when there is nothing to merge", () => {
    expect(mergeArtifactSummaries([])).toBeNull();
  });

  it("dedupes by path (last wins), keeps first-appearance order", () => {
    const merged = mergeArtifactSummaries([
      artEntry("a1", [{ path: "/out/report.html", primary: true, bytes: 10 }, { path: "/out/data.csv" }]).summary,
      artEntry("a2", [{ path: "/out/report.html", bytes: 99 }]).summary,
    ]);
    expect(merged!.items.map((i) => i.name)).toEqual(["report.html", "data.csv"]);
    expect(merged!.items[0].bytes).toBe(99);
  });

  it("keeps the last explanation and the surviving primary", () => {
    const merged = mergeArtifactSummaries([
      artEntry("a1", [{ path: "/out/a.html", primary: true }], "第一版").summary,
      artEntry("a2", [{ path: "/out/b.md", primary: true }], "最终版").summary,
    ]);
    expect(merged!.explanation).toBe("最终版");
    expect(merged!.primary?.path).toBe("/out/b.md");
  });
});

describe("foldRunArtifacts", () => {
  it("moves a run's artifacts into its changes card, in declaration order", () => {
    const tl: TimelineEntry[] = [
      userEntry("u1"),
      artEntry("a1", [{ path: "/out/report.html", primary: true }, { path: "/out/data.csv" }], "本次交付"),
      changesEntry("c1"),
    ];
    const out = foldRunArtifacts(tl, true);
    expect(out.map((e) => e.id)).toEqual(["u1", "c1"]);
    const card = out[1] as ChangesEntry;
    expect(card.artifacts?.items.map((i) => i.name)).toEqual(["report.html", "data.csv"]);
    expect(card.artifacts?.explanation).toBe("本次交付");
  });

  it("leaves the input timeline untouched", () => {
    const tl: TimelineEntry[] = [changesEntry("c1"), artEntry("a1", [{ path: "/out/x.md" }])];
    const before = (tl[0] as ChangesEntry).artifacts;
    foldRunArtifacts(tl, true);
    expect(tl[0]).toEqual({ id: "c1", kind: "changes", files: [], totalAdded: 3, totalRemoved: 1 });
    expect((tl[0] as ChangesEntry).artifacts).toBe(before);
  });

  it("holds trailing artifacts back while the run is live", () => {
    const tl: TimelineEntry[] = [userEntry("u1"), artEntry("a1", [{ path: "/out/x.md" }])];
    expect(foldRunArtifacts(tl, true).map((e) => e.id)).toEqual(["u1"]);
  });

  it("puts them back in place once a card-less run has settled", () => {
    const tl: TimelineEntry[] = [userEntry("u1"), artEntry("a1", [{ path: "/out/x.md" }])];
    expect(foldRunArtifacts(tl, false).map((e) => e.id)).toEqual(["u1", "a1"]);
  });

  it("keeps a card-less run's artifacts where they were declared", () => {
    const tl: TimelineEntry[] = [userEntry("u1"), artEntry("a1", [{ path: "/out/x.md" }]), userEntry("u2")];
    expect(foldRunArtifacts(tl, true).map((e) => e.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("never carries a previous run's artifacts into the next run's card", () => {
    const tl: TimelineEntry[] = [userEntry("u1"), artEntry("a1", [{ path: "/out/x.md" }]), userEntry("u2"), changesEntry("c2")];
    const out = foldRunArtifacts(tl, false);
    expect(out.map((e) => e.id)).toEqual(["u1", "a1", "u2", "c2"]);
    expect((out[3] as ChangesEntry).artifacts).toBeUndefined();
  });

  it("merges several declarations of one run into one section", () => {
    const tl: TimelineEntry[] = [
      userEntry("u1"),
      artEntry("a1", [{ path: "/out/report.html", primary: true }]),
      artEntry("a2", [{ path: "/out/report.html", bytes: 42 }, { path: "https://example.com/doc" }]),
      changesEntry("c1"),
    ];
    const out = foldRunArtifacts(tl, true);
    expect(out.map((e) => e.id)).toEqual(["u1", "c1"]);
    const items = (out[1] as ChangesEntry).artifacts!.items;
    expect(items.map((i) => i.path)).toEqual(["/out/report.html", "https://example.com/doc"]);
    expect(items[0].bytes).toBe(42);
  });

  it("gives each run its own artifacts", () => {
    const tl: TimelineEntry[] = [
      userEntry("u1"), artEntry("a1", [{ path: "/out/one.html" }]), changesEntry("c1"),
      userEntry("u2"), artEntry("a2", [{ path: "/out/two.html" }]), changesEntry("c2"),
    ];
    const out = foldRunArtifacts(tl, false);
    expect(out.map((e) => e.id)).toEqual(["u1", "c1", "u2", "c2"]);
    expect((out[1] as ChangesEntry).artifacts!.items[0].name).toBe("one.html");
    expect((out[3] as ChangesEntry).artifacts!.items[0].name).toBe("two.html");
  });

  it("leaves runs without artifacts alone", () => {
    const tl: TimelineEntry[] = [userEntry("u1"), changesEntry("c1")];
    const out = foldRunArtifacts(tl, true);
    expect(out[1]).toBe(tl[1]);
    expect((out[1] as ChangesEntry).artifacts).toBeUndefined();
  });
});
