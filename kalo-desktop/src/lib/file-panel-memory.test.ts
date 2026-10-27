import { describe, expect, it, vi } from "vitest";
import {
  activateFileInMemory,
  adoptPanelMemory,
  closeFileInMemory,
  openFileInMemory,
  openFileOf,
  patchPanelMemory,
  queuePanelArtifactOpen,
  resolvePanelMemory,
  setFileViewInMemory,
  subscribePanelMemory,
  type FileView,
  type PanelMemory,
} from "./file-panel-memory";

const file = (path: string, view: FileView = "source", relPath: string | null = null) => ({
  name: path.split("/").pop() ?? path,
  path,
  relPath,
  view,
});

/** One session's memory holding `paths` as its open file tabs, `active` focused. */
function withTabs(uid: string, paths: string[], active: string | null = null): PanelMemory {
  patchPanelMemory(uid, "D:/repo", { openFiles: paths.map((p) => file(p)), activeFile: active });
  return resolvePanelMemory(uid, "D:/repo");
}

describe("resolvePanelMemory", () => {
  it("starts blank for a session that was never browsed", () => {
    const m = resolvePanelMemory("uid-blank", "D:/repo");
    expect(m).toEqual({
      rootOverride: null,
      root: "D:/repo",
      expanded: [],
      openFiles: [],
      activeFile: null,
      changesOnly: false,
      treeVisible: false,
      backStack: [],
      artifactsOpen: true,
      pendingArtifact: null,
    });
  });

  it("returns what was patched in", () => {
    patchPanelMemory("uid-roundtrip", "D:/repo", {
      expanded: ["D:/repo/src"],
      openFiles: [file("D:/repo/README.md", "diff")],
      activeFile: "D:/repo/README.md",
      changesOnly: true,
      backStack: ["D:/repo"],
      artifactsOpen: false,
    });
    const m = resolvePanelMemory("uid-roundtrip", "D:/repo");
    expect(m.expanded).toEqual(["D:/repo/src"]);
    expect(m.openFiles.map((f) => f.name)).toEqual(["README.md"]);
    expect(m.openFiles[0].view).toBe("diff");
    expect(m.activeFile).toBe("D:/repo/README.md");
    expect(m.changesOnly).toBe(true);
    expect(m.backStack).toEqual(["D:/repo"]);
    expect(m.artifactsOpen).toBe(false);
  });

  it("keeps sessions apart", () => {
    patchPanelMemory("uid-a", "D:/repo", { openFiles: [file("D:/repo/a.ts")], activeFile: "D:/repo/a.ts" });
    patchPanelMemory("uid-b", "D:/repo", { openFiles: [file("D:/repo/b.ts")], activeFile: "D:/repo/b.ts" });
    expect(resolvePanelMemory("uid-a", "D:/repo").openFiles[0].name).toBe("a.ts");
    expect(resolvePanelMemory("uid-b", "D:/repo").openFiles[0].name).toBe("b.ts");
  });

  it("remembers tree visibility without closing files or changing another session", () => {
    const before = withTabs("uid-tree-hidden", ["D:/repo/a.md"], "D:/repo/a.md");
    patchPanelMemory("uid-tree-hidden", "D:/repo", { treeVisible: true });
    expect(resolvePanelMemory("uid-tree-hidden", "D:/repo").treeVisible).toBe(true);
    expect(resolvePanelMemory("uid-tree-other", "D:/repo").treeVisible).toBe(false);
    patchPanelMemory("uid-tree-hidden", "D:/repo", { treeVisible: false });
    const hidden = resolvePanelMemory("uid-tree-hidden", "D:/repo");
    expect(hidden.openFiles).toEqual(before.openFiles);
    expect(hidden.activeFile).toBe(before.activeFile);
    expect(hidden.treeVisible).toBe(false);
    expect(resolvePanelMemory("uid-tree-other", "D:/repo").treeVisible).toBe(false);
  });
});

describe("root baseline", () => {
  it("drops the expanded set but keeps the open files when cwd moves", () => {
    patchPanelMemory("uid-moved", "D:/old", {
      expanded: ["D:/old/src"],
      openFiles: [file("D:/old/README.md")],
      activeFile: "D:/old/README.md",
    });
    const m = resolvePanelMemory("uid-moved", "D:/new");
    expect(m.root).toBe("D:/new");
    expect(m.expanded).toEqual([]);
    expect(m.openFiles[0].path).toBe("D:/old/README.md");
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
    patchPanelMemory("uid-keep", "D:/repo", { openFiles: [file("D:/repo/README.md")] });
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

describe("openFileInMemory", () => {
  it("appends a new tab and makes it current", () => {
    const partial = openFileInMemory(withTabs("uid-tabs-add", []), {
      name: "b.md",
      path: "D:/repo/b.md",
      relPath: "b.md",
    });
    expect(partial.openFiles).toEqual([{ name: "b.md", path: "D:/repo/b.md", relPath: "b.md", view: "source" }]);
    expect(partial.activeFile).toBe("D:/repo/b.md");
  });

  it("focuses the tab a file already has instead of stacking a second one", () => {
    const m = withTabs("uid-tabs-dedupe", ["D:/repo/a.ts", "D:/repo/b.ts"], "D:/repo/b.ts");
    const partial = openFileInMemory(m, { name: "a.ts", path: "D:/Repo/A.TS" });
    expect(partial.openFiles?.map((f) => f.path)).toEqual(["D:/repo/a.ts", "D:/repo/b.ts"]);
    // 焦点用存下来的路径：窗口大小写差异不会带来第二个页签
    expect(partial.activeFile).toBe("D:/repo/a.ts");
  });

  it("keeps the view and relPath a tab already had when the caller omits them", () => {
    const m = withTabs("uid-tabs-keep", ["D:/repo/a.ts"], "D:/repo/a.ts");
    const diffed = { ...m, ...setFileViewInMemory(m, "D:/repo/a.ts", "diff") };
    const partial = openFileInMemory(diffed, { name: "a.ts", path: "D:/repo/a.ts" });
    expect(partial.openFiles?.[0].view).toBe("diff");
  });

  it("lets the caller override the view it asks for", () => {
    const m = withTabs("uid-tabs-view", ["D:/repo/a.ts"], "D:/repo/a.ts");
    expect(openFileInMemory(m, { name: "a.ts", path: "D:/repo/a.ts", view: "diff" }).openFiles?.[0].view).toBe("diff");
  });

  it("fills in a relPath the opener did not know", () => {
    const m = withTabs("uid-tabs-relpath", ["D:/repo/a.ts"], "D:/repo/a.ts");
    const partial = openFileInMemory(m, { name: "a.ts", path: "D:/repo/a.ts", relPath: "a.ts" });
    expect(partial.openFiles?.[0].relPath).toBe("a.ts");
  });
});

describe("openFileOf", () => {
  it("finds a tab by path, ignoring case and separators", () => {
    const m = withTabs("uid-tabs-of", ["D:/repo/a.ts"]);
    expect(openFileOf(m, "d:\\REPO\\A.TS")?.name).toBe("a.ts");
  });

  it("has nothing for no path or an unknown one", () => {
    const m = withTabs("uid-tabs-of2", ["D:/repo/a.ts"]);
    expect(openFileOf(m, null)).toBeNull();
    expect(openFileOf(m, "")).toBeNull();
    expect(openFileOf(m, "D:/repo/zz.ts")).toBeNull();
  });
});

describe("closeFileInMemory", () => {
  it("falls back to the neighbour on the left when the current tab closes", () => {
    const m = withTabs("uid-tabs-close", ["D:/repo/a.ts", "D:/repo/b.ts", "D:/repo/c.ts"], "D:/repo/b.ts");
    const partial = closeFileInMemory(m, "D:/repo/b.ts");
    expect(partial.openFiles?.map((f) => f.name)).toEqual(["a.ts", "c.ts"]);
    expect(partial.activeFile).toBe("D:/repo/a.ts");
  });

  it("falls back to the tab that took the closed first tab's place", () => {
    const m = withTabs("uid-tabs-close2", ["D:/repo/a.ts", "D:/repo/b.ts"], "D:/repo/a.ts");
    expect(closeFileInMemory(m, "D:/repo/a.ts").activeFile).toBe("D:/repo/b.ts");
  });

  it("closes the last tab into no tab at all, which brings the tree back", () => {
    const m = withTabs("uid-tabs-close3", ["D:/repo/a.ts"], "D:/repo/a.ts");
    const partial = closeFileInMemory(m, "D:/repo/a.ts");
    expect(partial.openFiles).toEqual([]);
    expect(partial.activeFile).toBeNull();
  });

  it("leaves the current tab alone when another one closes", () => {
    const m = withTabs("uid-tabs-close4", ["D:/repo/a.ts", "D:/repo/b.ts"], "D:/repo/a.ts");
    const partial = closeFileInMemory(m, "D:/repo/b.ts");
    expect(partial.openFiles?.map((f) => f.name)).toEqual(["a.ts"]);
    expect("activeFile" in partial).toBe(false);
  });

  it("is a no-op for a path that is not open", () => {
    const m = withTabs("uid-tabs-close5", ["D:/repo/a.ts"], "D:/repo/a.ts");
    expect(closeFileInMemory(m, "D:/repo/z.ts")).toEqual({});
  });
});

describe("setFileViewInMemory", () => {
  it("switches one tab's view and nobody else's", () => {
    const m = withTabs("uid-tabs-set", ["D:/repo/a.ts", "D:/repo/b.ts"], "D:/repo/a.ts");
    expect(setFileViewInMemory(m, "D:/repo/b.ts", "diff").openFiles?.map((f) => f.view)).toEqual(["source", "diff"]);
  });

  it("is a no-op for a path that is not open", () => {
    const m = withTabs("uid-tabs-set2", ["D:/repo/a.ts"], "D:/repo/a.ts");
    expect(setFileViewInMemory(m, "D:/repo/z.ts", "diff")).toEqual({});
  });
});

describe("activateFileInMemory", () => {
  it("focuses an open tab under the path it was stored with", () => {
    const m = withTabs("uid-tabs-act", ["D:/repo/a.ts", "D:/repo/b.ts"]);
    expect(activateFileInMemory(m, "d:\\repo\\B.TS")).toEqual({ activeFile: "D:/repo/b.ts" });
  });

  it("clears the focus with null, which is how the tree comes back", () => {
    const m = withTabs("uid-tabs-act2", ["D:/repo/a.ts"], "D:/repo/a.ts");
    expect(activateFileInMemory(m, null)).toEqual({ activeFile: null });
  });

  it("is a no-op for a path that is not open", () => {
    const m = withTabs("uid-tabs-act3", ["D:/repo/a.ts"]);
    expect(activateFileInMemory(m, "D:/repo/z.ts")).toEqual({});
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
    patchPanelMemory("uid-keep-art", "D:/repo", { openFiles: [file("D:/out/b.html")] });
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

  it("lands as an open file tab, the way the strip consumes it", () => {
    queuePanelArtifactOpen("uid-consume", "D:/repo", { kind: "file", name: "a.html", path: "D:/out/a.html" });
    const m = resolvePanelMemory("uid-consume", "D:/repo");
    const pending = m.pendingArtifact!;
    patchPanelMemory("uid-consume", "D:/repo", {
      ...openFileInMemory(m, { name: pending.name, path: pending.path }),
      pendingArtifact: null,
    });
    const after = resolvePanelMemory("uid-consume", "D:/repo");
    expect(after.pendingArtifact).toBeNull();
    expect(after.openFiles.map((f) => f.name)).toEqual(["a.html"]);
    expect(after.activeFile).toBe("D:/out/a.html");
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
    patchPanelMemory("fresh-9", "D:/repo", { openFiles: [file("D:/repo/a.ts")], activeFile: "D:/repo/a.ts" });
    adoptPanelMemory("fresh-9", "d:/sessions/p.jsonl");
    expect(resolvePanelMemory("fresh-9", "D:/repo").openFiles[0].name).toBe("a.ts");
    // 引擎被驱逐后再从侧边栏打开同一会话：uid 已经是会话文件路径。
    expect(resolvePanelMemory("d:/sessions/p.jsonl", "D:/repo").openFiles[0].name).toBe("a.ts");
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
