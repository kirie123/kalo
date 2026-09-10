import { describe, expect, it } from "vitest";
import {
  mergeSessionRows,
  orderRows,
  updateFreeze,
  visibleRows,
  type FreezeTable,
  type SessionRow,
} from "./session-rows";
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

// doc/2026-09-10-运行中会话排序冻结.md — a session with a run in flight keeps
// the position it had when the run started, so it doesn't hop around the
// sidebar as its file's mtime keeps ticking.
describe("updateFreeze / orderRows", () => {
  const row = (path: string, modifiedMs: number): SessionRow => ({
    path,
    id: `id-${path}`,
    timestamp: modifiedMs,
    title: path,
    modifiedMs,
    cwd: "d:\proj",
  });
  const running = (...paths: string[]) => (p: string) => paths.includes(p);
  const order = (rows: SessionRow[], freeze: FreezeTable) => orderRows(rows, freeze).map((r) => r.path);

  it("keeps a running session in place while its mtime climbs", () => {
    const before = [row("b.jsonl", 200), row("a.jsonl", 100)];
    const freeze = updateFreeze({}, before, running("a.jsonl"));
    // a.jsonl streams past b.jsonl's mtime — it must not jump to the top.
    const after = [row("a.jsonl", 500), row("b.jsonl", 200)];
    expect(order(after, freeze)).toEqual(["b.jsonl", "a.jsonl"]);
  });

  it("releases the row once the run ends, back to real mtime order", () => {
    const rows = [row("a.jsonl", 500), row("b.jsonl", 200)];
    let freeze = updateFreeze({}, [row("b.jsonl", 200), row("a.jsonl", 100)], running("a.jsonl"));
    freeze = updateFreeze(freeze, rows, running());
    expect(freeze).toEqual({});
    expect(order(rows, freeze)).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("does not let two running sessions swap places", () => {
    const start = [row("a.jsonl", 300), row("b.jsonl", 200)];
    const freeze = updateFreeze({}, start, running("a.jsonl", "b.jsonl"));
    // b produces far more output than a; order must still be a, b.
    const later = [row("b.jsonl", 900), row("a.jsonl", 310)];
    expect(order(later, freeze)).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("still sorts non-running rows by mtime around a frozen one", () => {
    const freeze = updateFreeze({}, [row("a.jsonl", 100)], running("a.jsonl"));
    const rows = [row("a.jsonl", 999), row("c.jsonl", 300), row("b.jsonl", 50)];
    expect(order(rows, freeze)).toEqual(["c.jsonl", "a.jsonl", "b.jsonl"]);
  });

  it("normalizes paths like the pool keys do (Windows)", () => {
    const freeze = updateFreeze({}, [row("D:\\S\\A.jsonl", 100)], running("D:\\S\\A.jsonl"));
    expect(freeze).toEqual({ "d:/s/a.jsonl": 100 });
  });

  it("returns the same table when nothing changed", () => {
    const rows = [row("a.jsonl", 100)];
    const first = updateFreeze({}, rows, running("a.jsonl"));
    const second = updateFreeze(first, [row("a.jsonl", 400)], running("a.jsonl"));
    expect(second).toBe(first);
  });

  it("drops entries for rows that disappeared (deleted session)", () => {
    const freeze = updateFreeze({}, [row("a.jsonl", 100)], running("a.jsonl"));
    expect(updateFreeze(freeze, [], running("a.jsonl"))).toEqual({});
  });

  it("returns the input array untouched when nothing is frozen", () => {
    const rows = [row("a.jsonl", 100)];
    expect(orderRows(rows, {})).toBe(rows);
  });
});
