import { describe, expect, it } from "vitest";
import { appendNotice, noticeFor, parseRead, taskLine } from "./orchestrator";
import type { TaskView } from "../../../shared/workbench";

const task = (over: Partial<TaskView>) => ({
  id: "t-1", title: "整理资料", status: "running", profile: "research",
  updatedAt: "2026-11-12T00:00:00.000Z", ...over,
}) as TaskView;

describe("只有需要人处理的状态才叫醒助理", () => {
  it("运行中与已完成不产生通知", () => {
    for (const status of ["todo", "queued", "running", "settling", "completed", "stopped"] as const) {
      expect(noticeFor(task({ status }), "进展")).toBeUndefined();
    }
  });

  it("待验收、需恢复、等你回答各产生一条带原因的通知", () => {
    expect(noticeFor(task({ status: "review" }), "摘要已就绪")).toContain("待验收");
    expect(noticeFor(task({ status: "failed" }), "缺少凭证")).toContain("需要恢复");
    expect(noticeFor(task({ status: "waiting" }), "")).toContain("等你回答");
    expect(noticeFor(task({ status: "waiting" }), "")).toContain("task t-1");
  });

  it("积压只保留最新若干条", () => {
    const many = Array.from({ length: 30 }, (_, i) => `n-${i}`).reduce<string[]>((acc, n) => appendNotice(acc, n), []);
    expect(many).toHaveLength(20);
    expect(many.at(-1)).toBe("n-29");
    expect(many[0]).toBe("n-10");
  });
});

describe("资源名只允许白名单", () => {
  it("tasks / profile / task:<id> 通过，分页有界", () => {
    expect(parseRead({ resource: "tasks" })).toEqual({ resource: "tasks", offset: 0, limit: 20 });
    expect(parseRead({ resource: "profile" }).resource).toBe("profile");
    expect(parseRead({ resource: "task: abc ", offset: 5, limit: 50 })).toEqual({ resource: "task", id: "abc", offset: 5, limit: 50 });
  });

  it("越界与非白名单资源被拒，模型不能凭前缀读别的列表", () => {
    expect(() => parseRead({ resource: "tasks", limit: 51 })).toThrow("1~50");
    expect(() => parseRead({ resource: "tasks", offset: -1 })).toThrow("非负");
    expect(() => parseRead({ resource: "secrets" })).toThrow("未知资源");
    expect(() => parseRead({ resource: "task:" })).toThrow("缺少任务 ID");
  });

  it("对外行只暴露路由需要的字段", () => {
    expect(taskLine(task({}))).toEqual({ id: "t-1", title: "整理资料", status: "running", profile: "research", updatedAt: "2026-11-12T00:00:00.000Z" });
  });
});
