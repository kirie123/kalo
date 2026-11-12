import { describe, expect, it } from "vitest";
import type { TaskStatus, TaskView } from "../../shared/workbench";
import { columnOf, dropAction, groupByColumn } from "./workbench-board";

const ALL: TaskStatus[] = ["todo", "routing", "queued", "running", "settling", "waiting", "review", "completed", "failed", "stopping", "stopped"];

describe("看板列是任务状态的投影", () => {
  it("每个状态恰好落在一列，需要你只含等回答/待验收/需恢复", () => {
    expect(ALL.filter(s => columnOf(s) === "attention")).toEqual(["waiting", "review", "failed"]);
    expect(ALL.filter(s => columnOf(s) === "active")).toEqual(["routing", "running", "settling", "stopping"]);
    expect(ALL.filter(s => columnOf(s) === "done")).toEqual(["completed", "stopped"]);
  });

  it("同列按更新时间倒序，重试不会产生第二张卡", () => {
    const task = (id: string, status: TaskStatus, updatedAt: string) => ({ id, status, updatedAt }) as TaskView;
    const groups = groupByColumn([task("a", "running", "2026-11-12T01:00:00Z"), task("b", "settling", "2026-11-12T02:00:00Z"), task("c", "todo", "2026-11-12T00:00:00Z")]);
    expect(groups.active.map(t => t.id)).toEqual(["b", "a"]);
    expect(groups.todo.map(t => t.id)).toEqual(["c"]);
    expect(groups.queued).toEqual([]);
  });
});

describe("拖拽只映射合法动作", () => {
  it("待办⇄排队中是派发与撤回", () => {
    expect(dropAction({ status: "todo" }, "queued")).toEqual({ action: "dispatch" });
    expect(dropAction({ status: "queued" }, "todo")).toEqual({ action: "withdraw" });
  });

  it("同列放下不产生动作", () => {
    expect(dropAction({ status: "running" }, "active")).toBeUndefined();
  });

  it("不能拖进执行中、需要你、已完成，也不能把已开始的任务拖回待办", () => {
    for (const to of ["active", "attention", "done"] as const) expect(dropAction({ status: "todo" }, to)).toHaveProperty("refused");
    expect(dropAction({ status: "running" }, "todo")).toHaveProperty("refused");
    expect(dropAction({ status: "review" }, "queued")).toHaveProperty("refused");
  });
});
