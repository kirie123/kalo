import { describe, expect, it, vi } from "vitest";
import {
  adoptPanelMemory,
  patchPanelMemory,
  queuePanelArtifactOpen,
  resolvePanelMemory,
  subscribePanelMemory,
} from "./file-panel-memory";

const preview = (path: string) => ({ name: path.split("/").pop() ?? path, path, relPath: null });

describe("resolvePanelMemory", () => {
  it("starts blank for a session that was never browsed", () => {
    const m = resolvePanelMemory("uid-blank", "D:/repo");
    expect(m).toEqual({
      rootOverride: null,
      root: "D:/repo",
      expanded: [],
      preview: null,
      previewTab: "source",
      changesOnly: false,
      backStack: [],
      artifactsOpen: true,
      pendingArtifact: null,
    });
  });

  it("returns what was patched in", () => {
    patchPanelMemory("uid-roundtrip", "D:/repo", {
      expanded: ["D:/repo/src"],
      preview: preview("D:/repo/README.md"),
      previewTab: "diff",
      changesOnly: true,
      backStack: ["D:/repo"],
      artifactsOpen: false,
    });
    const m = resolvePanelMemory("uid-roundtrip", "D:/repo");
    expect(m.expanded).toEqual(["D:/repo/src"]);
    expect(m.preview?.path).toBe("D:/repo/README.md");
    expect(m.previewTab).toBe("diff");
    expect(m.changesOnly).toBe(true);
    expect(m.backStack).toEqual(["D:/repo"]);
    expect(m.artifactsOpen).toBe(false);
  });

  it("keeps sessions apart", () => {
    patchPanelMemory("uid-a", "D:/repo", { preview: preview("D:/repo/a.ts") });
    patchPanelMemory("uid-b", "D:/repo", { preview: preview("D:/repo/b.ts") });
    expect(resolvePanelMemory("uid-a", "D:/repo").preview?.name).toBe("a.ts");
    expect(resolvePanelMemory("uid-b", "D:/repo").preview?.name).toBe("b.ts");
  });
});

describe("root baseline", () => {
  it("drops the expanded set but keeps the open file when cwd moves", () => {
    patchPanelMemory("uid-moved", "D:/old", {
      expanded: ["D:/old/src"],
      preview: preview("D:/old/README.md"),
    });
    const m = resolvePanelMemory("uid-moved", "D:/new");
    expect(m.root).toBe("D:/new");
    expect(m.expanded).toEqual([]);
    expect(m.preview?.path).toBe("D:/old/README.md");
  });

  it("a browsed root follows rootOverride, not cwd", () => {
    patchPanelMemory("uid-browse", "D:/repo", { rootOverride: "D:/other", expanded: ["D:/other/x"] });
    const m = resolvePanelMemory("uid-browse", "D:/elsewhere");
    expect(m.root).toBe("D:/other");
    expect(m.expanded).toEqual(["D:/other/x"]);
  });

  it("clearing rootOverride back to the cwd invalidates the other root's expansion", () => {
    patchPanelMemory("uid-clear", "D:/repo", { rootOverride: "D:/other", expanded: ["D:/other/x"] });
    patchPanelMemory("uid-clear", "D:/repo", { rootOverride: null });
    const m = resolvePanelMemory("uid-clear", "D:/repo");
    expect(m.root).toBe("D:/repo");
    expect(m.expanded).toEqual([]);
  });

  it("a patch that keeps the root keeps the expansion", () => {
    patchPanelMemory("uid-keep", "D:/repo", { expanded: ["D:/repo/src"] });
    patchPanelMemory("uid-keep", "D:/repo", { preview: preview("D:/repo/README.md") });
    expect(resolvePanelMemory("uid-keep", "D:/repo").expanded).toEqual(["D:/repo/src"]);
  });
});

describe("patched snapshots are not shared", () => {
  it("does not hand the stored object's arrays to later patches", () => {
    patchPanelMemory("uid-copy", "D:/repo", { expanded: ["D:/repo/src"] });
    const before = resolvePanelMemory("uid-copy", "D:/repo");
    patchPanelMemory("uid-copy", "D:/repo", { expanded: [...before.expanded, "D:/repo/doc"] });
    expect(before.expanded).toEqual(["D:/repo/src"]);
    expect(resolvePanelMemory("uid-copy", "D:/repo").expanded).toEqual(["D:/repo/src", "D:/repo/doc"]);
  });
});

describe("pending artifact (present_files auto-open)", () => {
  it("queues a deliverable for its own session only", () => {
    queuePanelArtifactOpen("uid-art", "D:/repo", { kind: "file", name: "report.html", path: "D:/out/report.html" });
    expect(resolvePanelMemory("uid-art", "D:/repo").pendingArtifact).toEqual({
      name: "report.html",
      path: "D:/out/report.html",
    });
    // 别的会话（比如正在看的那个）什么也不会多出来。
    expect(resolvePanelMemory("uid-elsewhere", "D:/repo").pendingArtifact).toBeNull();
  });

  it("drops URLs and missing files instead of queueing a dead open", () => {
    queuePanelArtifactOpen("uid-url", "D:/repo", { kind: "url", name: "y", path: "https://x/y" });
    queuePanelArtifactOpen("uid-gone", "D:/repo", { kind: "file", name: "gone.md", path: "D:/out/gone.md", missing: true });
    expect(resolvePanelMemory("uid-url", "D:/repo").pendingArtifact).toBeNull();
    expect(resolvePanelMemory("uid-gone", "D:/repo").pendingArtifact).toBeNull();
  });

  it("survives unrelated patches and is cleared the same way it was set", () => {
    queuePanelArtifactOpen("uid-keep-art", "D:/repo", { kind: "file", name: "a.html", path: "D:/out/a.html" });
    patchPanelMemory("uid-keep-art", "D:/repo", { preview: preview("D:/out/b.html") });
    expect(resolvePanelMemory("uid-keep-art", "D:/repo").pendingArtifact?.name).toBe("a.html");
    patchPanelMemory("uid-keep-art", "D:/repo", { pendingArtifact: null });
    expect(resolvePanelMemory("uid-keep-art", "D:/repo").pendingArtifact).toBeNull();
  });

  it("notifies the panel so an open file area reacts without a session switch", () => {
    const seen = vi.fn();
    const off = subscribePanelMemory(seen);
    queuePanelArtifactOpen("uid-notify", "D:/repo", { kind: "file", name: "a.html", path: "D:/out/a.html" });
    off();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("subscription", () => {
  it("notifies listeners on patch and stops after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribePanelMemory(seen);
    patchPanelMemory("uid-sub", "D:/repo", { changesOnly: true });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    patchPanelMemory("uid-sub", "D:/repo", { changesOnly: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("adoptPanelMemory (fresh-N -> session file)", () => {
  it("moves the memory to the session file so a later reopen finds it", () => {
    patchPanelMemory("fresh-9", "D:/repo", { preview: preview("D:/repo/a.ts") });
    adoptPanelMemory("fresh-9", "d:/sessions/p.jsonl");
    expect(resolvePanelMemory("fresh-9", "D:/repo").preview?.name).toBe("a.ts");
    // 引擎被驱逐后再从侧边栏打开同一会话：uid 已经是会话文件路径。
    expect(resolvePanelMemory("d:/sessions/p.jsonl", "D:/repo").preview?.name).toBe("a.ts");
  });

  it("keeps writing through the alias after the move", () => {
    adoptPanelMemory("fresh-10", "d:/sessions/q.jsonl");
    patchPanelMemory("fresh-10", "D:/repo", { expanded: ["D:/repo/src"] });
    expect(resolvePanelMemory("d:/sessions/q.jsonl", "D:/repo").expanded).toEqual(["D:/repo/src"]);
  });

  it("is a no-op for a session resumed from disk", () => {
    patchPanelMemory("d:/sessions/r.jsonl", "D:/repo", { changesOnly: true });
    adoptPanelMemory("d:/sessions/r.jsonl", "d:/sessions/r.jsonl");
    expect(resolvePanelMemory("d:/sessions/r.jsonl", "D:/repo").changesOnly).toBe(true);
  });
});