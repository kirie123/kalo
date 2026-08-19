import { describe, expect, it } from "vitest";
import { mergeSessionRows, visibleRows, type SessionRow } from "./session-rows";
import type { PendingSession, ProjectGroup } from "../types";

const disk = (path: string, title: string, modifiedMs: number, cwd = "d:\\proj"): ProjectGroup => ({
  cwd,
  sessions: [{ path, id: `id-${title}`, timestamp: modifiedMs, title, modifiedMs }],
});

const pend = (path: string, title: string, modifiedMs: number, cwd = "d:\\proj"): PendingSession => ({
  path,
  id: `eng-${title}`,
  title,
  cwd,
  modifiedMs,
});

describe("mergeSessionRows", () => {
  it("passes on-disk sessions through with their group's cwd", () => {
    const rows = mergeSessionRows([disk("a.jsonl", "A", 100)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "a.jsonl", title: "A", cwd: "d:\\proj" });
    expect(rows[0].pending).toBeUndefined();
  });

  it("adds an optimistic row for a session not yet on disk", () => {
    const rows = mergeSessionRows([], [pend("pending:fresh-0", "写个脚本", 200)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "pending:fresh-0", title: "写个脚本", pending: true });
  });

  // The whole point of the dedup: for one refresh tick both sources describe
  // the same session, and a duplicate row is exactly what users would notice.
  it("drops an optimistic row once its file is on disk", () => {
    const rows = mergeSessionRows([disk("a.jsonl", "真标题", 100)], [pend("a.jsonl", "占位标题", 90)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("真标题");
    expect(rows[0].pending).toBeUndefined();
  });

  it("matches paths case-insensitively and across separators (Windows)", () => {
    const rows = mergeSessionRows(
      [disk("D:\\Sessions\\A.jsonl", "真标题", 100)],
      [pend("d:/sessions/a.jsonl", "占位标题", 90)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("真标题");
  });

  it("keeps an optimistic row whose file is genuinely different", () => {
    const rows = mergeSessionRows([disk("a.jsonl", "A", 100)], [pend("b.jsonl", "B", 90)]);
    expect(rows.map((r) => r.path).sort()).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("sorts newest first across both sources", () => {
    const rows = mergeSessionRows(
      [{ cwd: "d:\\proj", sessions: [
        { path: "old.jsonl", id: "1", timestamp: 100, title: "old", modifiedMs: 100 },
        { path: "mid.jsonl", id: "2", timestamp: 300, title: "mid", modifiedMs: 300 },
      ] }],
      [pend("pending:fresh-0", "new", 500)],
    );
    expect(rows.map((r) => r.title)).toEqual(["new", "mid", "old"]);
  });

  it("carries each pending row's own cwd, not the disk groups'", () => {
    const rows = mergeSessionRows([disk("a.jsonl", "A", 100, "d:\\one")], [pend("pending:fresh-0", "B", 200, "d:\\two")]);
    expect(rows.find((r) => r.title === "B")?.cwd).toBe("d:\\two");
  });

  it("handles both sides empty", () => {
    expect(mergeSessionRows([], [])).toEqual([]);
  });
});

describe("visibleRows", () => {
  const rows = (n: number): SessionRow[] =>
    Array.from({ length: n }, (_, i) => ({
      path: `s${i}.jsonl`,
      id: `id-${i}`,
      timestamp: 1000 - i,
      title: `S${i}`,
      modifiedMs: 1000 - i,
      cwd: "d:\\proj",
    }));

  it("returns the same array when the list fits", () => {
    const all = rows(3);
    expect(visibleRows(all, 10)).toBe(all);
  });

  it("returns everything at exactly the limit", () => {
    expect(visibleRows(rows(10), 10)).toHaveLength(10);
  });

  it("cuts to the limit past it", () => {
    expect(visibleRows(rows(25), 10).map((r) => r.title)).toEqual(
      rows(10).map((r) => r.title),
    );
  });

  it("keeps a marked row that falls past the limit", () => {
    const visible = visibleRows(rows(25), 10, (r) => r.id === "id-20");
    expect(visible).toHaveLength(11);
    expect(visible.at(-1)?.id).toBe("id-20");
  });

  it("does not duplicate a marked row already inside the limit", () => {
    const visible = visibleRows(rows(25), 10, (r) => r.id === "id-3");
    expect(visible).toHaveLength(10);
  });
});
