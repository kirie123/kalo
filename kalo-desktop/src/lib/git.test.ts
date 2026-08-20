import { describe, expect, it } from "vitest";
import {
  branchLabel,
  buildStatusIndex,
  groupByDir,
  parseUnifiedDiff,
  pathKey,
  relPathOf,
  statusLetter,
  statusOf,
} from "./git";
import type { GitEntry, GitStatus } from "../types";

function entry(relPath: string, over: Partial<GitEntry> = {}): GitEntry {
  return {
    relPath,
    path: `C:\\repo\\${relPath.replace(/\//g, "\\")}`,
    index: ".",
    worktree: "M",
    untracked: false,
    isDir: false,
    conflicted: false,
    submodule: false,
    binary: false,
    ...over,
  };
}

function status(entries: GitEntry[], over: Partial<GitStatus> = {}): GitStatus {
  return {
    repoRoot: "C:\\repo",
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    initial: false,
    entries,
    truncated: false,
    ...over,
  };
}

describe("buildStatusIndex", () => {
  it("finds an entry through a differently-cased native path", () => {
    const index = buildStatusIndex(status([entry("src/App.ts")]));
    // The tree may hand back a path with different casing or separators.
    expect(statusOf(index, "c:/repo/src/app.ts")).not.toBeNull();
    expect(statusOf(index, "C:\\REPO\\src\\App.ts")).not.toBeNull();
  });

  it("rolls a nested change up into every ancestor directory", () => {
    const index = buildStatusIndex(status([entry("src/a/b/c.ts")]));
    expect(index.dirs.get(pathKey("C:\\repo\\src\\a\\b"))?.count).toBe(1);
    expect(index.dirs.get(pathKey("C:\\repo\\src\\a"))?.count).toBe(1);
    expect(index.dirs.get(pathKey("C:\\repo\\src"))?.count).toBe(1);
    expect(index.dirs.get(pathKey("C:\\repo"))?.count).toBe(1);
  });

  it("counts each changed file once per ancestor, not once per repo", () => {
    const index = buildStatusIndex(
      status([entry("src/a.ts"), entry("src/b.ts"), entry("doc/x.md")]),
    );
    expect(index.dirs.get(pathKey("C:\\repo\\src"))?.count).toBe(2);
    expect(index.dirs.get(pathKey("C:\\repo\\doc"))?.count).toBe(1);
    expect(index.dirs.get(pathKey("C:\\repo"))?.count).toBe(3);
  });

  it("lets children of a collapsed untracked directory inherit its status", () => {
    // git reports the directory only; the tree still lists what is inside it.
    const index = buildStatusIndex(
      status([entry("build", { isDir: true, untracked: true, worktree: "?" })]),
    );
    const inherited = statusOf(index, "C:\\repo\\build\\deep\\out.js");
    expect(inherited?.untracked).toBe(true);
    expect(statusLetter(inherited)).toBe("?");
    // A sibling outside that directory inherits nothing.
    expect(statusOf(index, "C:\\repo\\src\\main.ts")).toBeNull();
  });

  it("is empty for a non-repository", () => {
    const index = buildStatusIndex(null);
    expect(index.byPath.size).toBe(0);
    expect(statusOf(index, "C:\\repo\\a.ts")).toBeNull();
  });
});

describe("statusLetter", () => {
  it("prefers the staged side over the work-tree side", () => {
    expect(statusLetter(entry("a.ts", { index: "A", worktree: "M" }))).toBe("A");
    expect(statusLetter(entry("a.ts", { index: ".", worktree: "M" }))).toBe("M");
    expect(statusLetter(entry("a.ts", { index: "R", worktree: "." }))).toBe("R");
  });

  it("reports conflicts and untracked ahead of the letters", () => {
    expect(statusLetter(entry("a.ts", { conflicted: true, index: "U", worktree: "U" }))).toBe("U");
    expect(statusLetter(entry("a.ts", { untracked: true, worktree: "?" }))).toBe("?");
  });

  it("is empty when nothing changed", () => {
    expect(statusLetter(entry("a.ts", { index: ".", worktree: "." }))).toBe("");
    expect(statusLetter(null)).toBe("");
  });
});

describe("branchLabel", () => {
  it("shows ahead/behind only when non-zero", () => {
    expect(branchLabel(status([], { ahead: 2, behind: 1 }))).toBe("main ↑2 ↓1");
    expect(branchLabel(status([], { ahead: 3 }))).toBe("main ↑3");
    expect(branchLabel(status([]))).toBe("main");
  });

  it("marks detached and empty repositories", () => {
    expect(branchLabel(status([], { detached: true, branch: "01234567" }))).toBe(
      "01234567 (detached)",
    );
    expect(branchLabel(status([], { initial: true }))).toBe("main (initial)");
  });
});

describe("relPathOf", () => {
  it("returns a posix path relative to the repo root", () => {
    expect(relPathOf(status([]), "C:\\repo\\src\\app.ts")).toBe("src/app.ts");
  });

  it("preserves the original casing git needs, while matching case-insensitively", () => {
    // The tree may report a different drive-letter case than git did.
    expect(relPathOf(status([]), "c:\\repo\\src\\App.ts")).toBe("src/App.ts");
  });

  it("is null outside the repository and for the root itself", () => {
    expect(relPathOf(status([]), "C:\\other\\a.ts")).toBeNull();
    expect(relPathOf(status([]), "C:\\repo")).toBeNull();
    // A sibling whose name merely starts with the root must not match.
    expect(relPathOf(status([]), "C:\\repo-backup\\a.ts")).toBeNull();
    expect(relPathOf(null, "C:\\repo\\a.ts")).toBeNull();
  });
});

describe("groupByDir", () => {  it("groups by parent directory with root files under an empty key", () => {
    const groups = groupByDir(status([entry("src/b.ts"), entry("README.md"), entry("src/a.ts")]));
    expect(groups.map((g) => g.dir)).toEqual(["", "src"]);
    expect(groups[1].entries.map((e) => e.relPath)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1234567..89abcde 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ function main() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
    "",
  ].join("\n");

  it("skips the preamble and numbers lines from the hunk header", () => {
    const lines = parseUnifiedDiff(diff);
    expect(lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(lines[0]).toMatchObject({ oldNo: 10, newNo: 10, text: "const a = 1;" });
    expect(lines[1]).toMatchObject({ oldNo: 11, text: "const b = 2;" });
    expect(lines[2]).toMatchObject({ newNo: 11, text: "const b = 3;" });
    expect(lines[3]).toMatchObject({ newNo: 12, text: "const c = 4;" });
    // Old side advanced by 1 delete + 1 context, new side by 2 adds + 1 context.
    expect(lines[4]).toMatchObject({ oldNo: 12, newNo: 13, text: "return a;" });
  });

  it("emits one skip row between hunks and none before the first", () => {
    const two = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -20,1 +20,1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(two);
    expect(lines.map((l) => l.kind)).toEqual(["del", "add", "skip", "del", "add"]);
    expect(lines[3]).toMatchObject({ oldNo: 20 });
  });

  it("handles single-line hunk headers without a count", () => {
    const lines = parseUnifiedDiff("@@ -5 +5 @@\n-a\n+b\n");
    expect(lines[0]).toMatchObject({ kind: "del", oldNo: 5 });
    expect(lines[1]).toMatchObject({ kind: "add", newNo: 5 });
  });

  it("drops the no-newline marker without consuming a line number", () => {
    const lines = parseUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n");
    expect(lines.map((l) => l.kind)).toEqual(["del", "add"]);
    expect(lines[1]).toMatchObject({ newNo: 1 });
  });

  it("keeps an empty context line but not the trailing newline", () => {
    const lines = parseUnifiedDiff("@@ -1,3 +1,3 @@\n a\n \n+b\n");
    expect(lines.map((l) => l.text)).toEqual(["a", "", "b"]);
  });

  it("strips the CR of a CRLF file's rows", () => {
    const lines = parseUnifiedDiff("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n");
    expect(lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("is empty for empty input and for a diff with no hunks", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toEqual([]);
  });
});
