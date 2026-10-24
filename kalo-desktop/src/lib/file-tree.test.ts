import { describe, expect, it } from "vitest";
import type { GitEntry } from "../types";
import { changedFileTree, fileBaseName, parentDirectory, pathBreadcrumbs } from "./file-tree";

const changed = (relPath: string, extra: Partial<GitEntry> = {}): GitEntry => ({
  relPath, path: `C:/repo/${relPath}`, isDir: false, index: ".", worktree: "M", untracked: false, conflicted: false, submodule: false, binary: false, ...extra,
});

describe("file panel navigation", () => {
  it("keeps drive and POSIX roots navigable without moving above them", () => {
    expect(pathBreadcrumbs("C:\\repo\\文档\\a.md")).toEqual([
      { name: "C:", path: "C:/" }, { name: "repo", path: "C:/repo" }, { name: "文档", path: "C:/repo/文档" }, { name: "a.md", path: "C:/repo/文档/a.md" },
    ]);
    expect(parentDirectory("C:\\repo\\")).toBe("C:/");
    expect(parentDirectory("C:\\")).toBeNull();
    expect(parentDirectory("/Users")).toBe("/");
    expect(parentDirectory("/")).toBeNull();
    expect(pathBreadcrumbs("/a.md")[1]).toEqual({ name: "a.md", path: "/a.md" });
  });

  it("treats a UNC share as a root and preserves spaces and case", () => {
    expect(parentDirectory("\\\\Host\\Share\\notes")).toBe("//Host/Share");
    expect(parentDirectory("\\\\Host\\Share\\")).toBeNull();
    expect(pathBreadcrumbs("//Host/Share/Some Notes/a.md").map((item) => item.name)).toEqual(["//Host/Share", "Some Notes", "a.md"]);
    expect(fileBaseName("C:\\Some Notes\\a.md")).toBe("a.md");
  });
});

describe("changed file hierarchy", () => {
  it("builds nested directories, orders folders first and preserves leaf status", () => {
    const entry = changed("src/nested/view.ts", { added: 5, removed: 2 });
    const nodes = changedFileTree("C:/repo", [changed("readme.md"), changed("src/index.ts"), entry]);
    expect(nodes.map((node) => node.name)).toEqual(["src", "readme.md"]);
    expect(nodes[0].children.map((node) => node.name)).toEqual(["nested", "index.ts"]);
    expect(nodes[0].children[0].children[0].entry).toBe(entry);
    expect(nodes[0].path).toBe("C:/repo/src");
  });

  it("matches a relative path case-insensitively and keeps ancestors", () => {
    const nodes = changedFileTree("C:/repo", [changed("src/views/a.ts"), changed("src/other.ts")], "SRC\\VIEWS");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].children[0].children[0].name).toBe("a.ts");
    expect(changedFileTree("C:/repo", [changed("src/a.ts")], "nothing")).toEqual([]);
  });

  it("keeps untracked directories navigable and similar filenames separate", () => {
    const nodes = changedFileTree("C:/repo", [changed("src/", { isDir: true, untracked: true }), changed("src.ts")]);
    expect(nodes.map((node) => [node.name, node.isDir])).toEqual([["src", true], ["src.ts", false]]);
    expect(nodes[0].entry?.untracked).toBe(true);
    expect(changedFileTree("/repo", [changed("a/b.ts", { path: "/repo/a/b.ts" })])[0].path).toBe("/repo/a");
  });
});
