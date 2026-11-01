import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../shared/workbench";
import { isActiveTask, needsAttention } from "./workbench-view";

describe("工作台收件箱与执行计数", () => {
  it("问题登记但进程尚未退出时不提前向用户要答案，停止中继续计入执行", () => {
    const tasks = (["routing", "queued", "running", "settling", "waiting", "review", "failed", "stopping", "completed", "stopped"] as TaskStatus[]).map(status => ({ status }));
    expect(tasks.filter(needsAttention).map(t => t.status)).toEqual(["waiting", "review", "failed"]);
    expect(tasks.filter(isActiveTask).map(t => t.status)).toEqual(["routing", "queued", "running", "settling", "stopping"]);
  });
});
