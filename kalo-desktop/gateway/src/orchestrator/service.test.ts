import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRun, sessionId, type Run, type WorkerMessage } from "./model";
import { TaskService, type TaskHost } from "./service";
import { TaskStore } from "./store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(reconcile = true) {
  const root = mkdtempSync(join(tmpdir(), "kalo-task-test-"));
  const cwd = join(root, "work");
  const sessionsRoot = join(root, "sessions");
  mkdirSync(cwd); mkdirSync(sessionsRoot);
  const store = new TaskStore(join(root, "tasks.sqlite"));
  const messages: WorkerMessage[] = [];
  const orchestratorDir = join(root, "assistant");
  mkdirSync(orchestratorDir);
  const host: TaskHost = { send: message => messages.push(message), changed() {}, endpoint: () => "http://127.0.0.1:12345", sessionsRoot, orchestratorDir };
  const service = new TaskService(store, host);
  if (reconcile) service.inventory([]);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (dir = cwd, allowShell = false) => {
    service.request({ action: "create", actionId: randomUUID(), prompt: "整理资料并生成摘要", cwd: dir, allowShell });
    // The orchestrator row is bookkeeping, never a task the fixture should pick up.
    return store.all().find(t => !ids.has(t.id) && t.kind !== "orchestrator")!;
  };
  const ids = new Set<string>();
  const task = (dir = cwd, allowShell = false) => {
    const t = create(dir, allowShell); ids.add(t.id);
    const sessionDir = join(sessionsRoot, t.id); mkdirSync(sessionDir);
    const r = activeRun(t)!;
    const sessionFile = join(sessionDir, `${r.id}.jsonl`); writeFileSync(sessionFile, "session fixture");
    r.sessionFile = sessionFile; store.put(t);
    return t;
  };
  const run = (id: string) => activeRun(store.get(id))!;
  const tool = (r: Run, operation: string, body: unknown) => store.atomic(() => service.tool(r.token, operation, body));
  const settle = (r: Run) => { service.event(sessionId(r.id), { type: "agent_settled" }); service.exit(sessionId(r.id)); };
  const route = (id: string) => {
    const r = run(id);
    tool(r, "context", { protocol: 1, role: "router" }); service.started(r.id);
    tool(r, "decide", { callId: randomUUID(), decision: "create", title: "资料摘要", goal: "整理资料", acceptance: "摘要有出处", reason: "委托明确" });
    settle(r);
    return run(id);
  };
  return { root, cwd, sessionsRoot, orchestratorDir, store, service, host, messages, task, run, tool, settle, route };
}

describe("orchestrator dispatch", () => {
  const wakeTurn = (f: ReturnType<typeof fixture>) => {
    const row = f.store.all().find(t => t.kind === "orchestrator")!;
    const run = activeRun(row);
    if (!run) return undefined;
    f.tool(run, "context", { protocol: 1, role: "orchestrator" });
    f.service.started(run.id);
    return run;
  };

  test("a person's message creates the dispatcher row, wakes one run, and shows in the panel", () => {
    const f = fixture();
    expect(f.store.all().some(t => t.kind === "orchestrator")).toBe(false);
    f.service.request({ action: "orchestrate", actionId: "m1", text: "帮我看一下竞品" });
    const row = f.store.all().find(t => t.kind === "orchestrator")!;
    expect(row.messages?.at(-1)).toMatchObject({ role: "user", text: "帮我看一下竞品" });
    const run = wakeTurn(f);
    expect(run?.role).toBe("orchestrator");
    // The dispatcher runs in its own directory, not in any task's workspace.
    const start = f.messages.find(m => m.type === "task_worker_start");
    expect(start?.type === "task_worker_start" && start.cwd).toBe(f.orchestratorDir);
    // The dispatcher is not a task the person sees.
    expect(f.service.list().some(t => t.id === row.id)).toBe(false);
  });

  test("task_route creates and dispatches in one call and keeps per-item failures separate", () => {
    const f = fixture();
    f.service.request({ action: "orchestrate", actionId: "m1", text: "拆两个任务" });
    const run = wakeTurn(f)!;
    const reply = f.tool(run, "route", {
      callId: "r1",
      items: [
        { prompt: "整理资料", cwd: f.cwd, acceptance: "摘要有出处", profile: "research" },
        { prompt: "越界", cwd: join(f.root, "missing"), acceptance: "x" },
        { prompt: "调研却要 shell", cwd: f.cwd, profile: "research", allowShell: true },
      ],
    }) as { results: { task?: unknown; error?: string }[] };
    expect(reply.results[0].task).toBeDefined();
    expect(reply.results[1].error).toContain("工作目录");
    expect(reply.results[2].error).toContain("调研");
    const created = f.store.all().filter(t => t.kind !== "orchestrator");
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("queued");
    expect(activeRun(created[0])?.role).toBe("worker");
  });

  test("the dispatcher cannot read files, resume work or accept results", () => {
    const f = fixture();
    f.service.request({ action: "orchestrate", actionId: "m1", text: "试试越权" });
    const run = wakeTurn(f)!;
    for (const name of ["read", "write", "bash", "grep", "web_fetch", "task_report", "agent", "task_resume"]) {
      expect(() => f.tool(run, "gate", { tool: name, input: {} })).toThrow("授权范围");
    }
    expect(() => f.tool(run, "report", { callId: "x", state: "ready", summary: "s" })).toThrow("不能调用");
    expect(f.tool(run, "gate", { tool: "task_route", input: {} })).toEqual({ ok: true });
  });

  test("a note reaches the worker's next run and starts no run of its own", () => {
    const f = fixture();
    const task = f.task();
    f.service.request({ action: "orchestrate", actionId: "m1", text: "附注一条" });
    const run = wakeTurn(f)!;
    const before = f.store.get(task.id).runs.length;
    f.tool(run, "note", { callId: "n1", taskId: task.id, text: "另一个任务已确定用中文" });
    expect(f.store.get(task.id).runs).toHaveLength(before);
    // A note alone never starts a run: it waits for the worker's next turn.
    expect(f.store.get(task.id).notes?.length).toBe(1);
  });

  test("attention states notify the dispatcher; routine progress does not", () => {
    const f = fixture();
    f.service.request({ action: "orchestrate", actionId: "m1", text: "等结果" });
    wakeTurn(f);
    f.settle(activeRun(f.store.all().find(t => t.kind === "orchestrator")!)!);
    const worker = f.route(f.task().id);
    f.tool(worker, "context", { protocol: 1, role: "worker" });
    f.service.started(worker.id);
    f.tool(worker, "ask", { callId: "q", question: "用哪个范围？" });
    f.settle(worker);
    const row = f.store.all().find(t => t.kind === "orchestrator")!;
    expect(row.pending?.some(n => n.includes("等你回答"))).toBe(true);
  });
});

describe("durable Router / Worker lifecycle", () => {
  test("question releases only after settlement and exit; answer resumes the original session and delivery needs acceptance", () => {
    const f = fixture();
    const task = f.task();
    const worker = f.route(task.id);
    f.tool(worker, "context", { protocol: 1, role: "worker" });
    f.service.started(worker.id);
    const sessionFile = join(f.sessionsRoot, task.id, "worker.jsonl");
    writeFileSync(sessionFile, "session fixture");
    f.tool(worker, "context", { sessionFile });
    const question = { callId: "ask-1", question: "摘要使用哪种语言？", options: ["中文", "英文"] };
    f.tool(worker, "ask", question);
    f.tool(worker, "ask", question); // lost HTTP response is safe to replay
    expect(f.store.get(task.id).history.filter(h => h.text.includes(question.question))).toHaveLength(1);
    expect(f.store.get(task.id).status).toBe("settling");
    const questionId = f.store.get(task.id).question!.id;
    const answer = { action: "answer", actionId: "answer-1", taskId: task.id, questionId, answer: "中文" };
    expect(() => f.service.request(answer)).toThrow("仍在结算");
    f.service.event(sessionId(worker.id), { type: "agent_settled" });
    expect(f.store.get(task.id).status).toBe("settling");
    expect(f.run(task.id).status).toBe("closing");
    f.service.exit(sessionId(worker.id));
    expect(f.store.get(task.id).status).toBe("waiting");
    expect(() => f.service.request({ ...answer, questionId: "stale" })).toThrow("问题已过期");
    f.service.request(answer); f.service.request(answer);
    const resumed = f.run(task.id);
    expect(resumed.id).not.toBe(worker.id);
    expect(resumed.sessionFile).toBe(sessionFile);
    expect(resumed.prompt).toContain("中文");
    expect(f.store.get(task.id).runs).toHaveLength(3);
    expect(() => f.tool(worker, "report", { callId: "late", state: "ready", summary: "旧执行" })).toThrow("凭据已失效");
    writeFileSync(join(f.cwd, "摘要.md"), "实际交付");
    f.tool(resumed, "report", { callId: "result", state: "ready", summary: "已核对来源并生成摘要", artifacts: ["摘要.md"] });
    f.settle(resumed);
    expect(f.store.get(task.id).status).toBe("review");
    expect(f.store.get(task.id).artifacts[0].name).toBe("摘要.md");
    f.service.request({ action: "accept", actionId: "accept-1", taskId: task.id });
    expect(f.store.get(task.id).status).toBe("completed");
    expect(JSON.stringify(f.service.list())).not.toContain(resumed.token);
  });

  test("create retries are idempotent and conflicting action IDs cannot mutate state", () => {
    const f = fixture();
    const request = { action: "create", actionId: "create-1", prompt: "整理", cwd: f.cwd, allowShell: false };
    f.service.request(request); f.service.request(request);
    expect(f.store.all()).toHaveLength(1);
    expect(f.messages.filter(m => m.type === "task_worker_start")).toHaveLength(1);
    expect(() => f.service.request({ ...request, prompt: "覆盖" })).toThrow("动作 ID");
    expect(f.store.all()[0].prompt).toBe("整理");
  });

  test("an old engine without the task handshake receives no prompt; duplicate readiness sends only one", () => {
    const f = fixture(); const task = f.task(); const run = f.run(task.id);
    f.service.started(run.id);
    expect(f.messages.some(m => m.type === "task_worker_prompt")).toBe(false);
    expect(f.run(task.id).status).toBe("closing");
    f.service.exit(sessionId(run.id));
    expect(f.store.get(task.id).summary).toContain("重建引擎");
    const g = fixture(); const ready = g.task(); const r = g.run(ready.id);
    expect(() => g.tool(r, "context", { protocol: 1, role: "worker" })).toThrow("角色不匹配");
    g.tool(r, "context", { protocol: 1, role: "router" });
    g.service.started(r.id); g.service.started(r.id);
    expect(g.messages.filter(m => m.type === "task_worker_prompt")).toHaveLength(1);
  });

  test("cancellation revokes tools immediately and keeps the slot until actual exit", () => {
    const f = fixture(); const task = f.task(); const worker = f.route(task.id);
    f.service.request({ action: "stop", actionId: "stop", taskId: task.id });
    expect(f.store.get(task.id).status).toBe("stopping");
    expect(() => f.tool(worker, "gate", { tool: "write", input: { path: "a.txt" } })).toThrow("停止");
    expect(() => f.service.request({ action: "retry", actionId: "retry", taskId: task.id })).toThrow("只有失败");
    f.service.started(worker.id);
    expect(f.store.get(task.id).status).toBe("stopping");
    f.service.exit(sessionId(worker.id));
    expect(f.store.get(task.id).status).toBe("stopped");
    f.service.event(sessionId(worker.id), { type: "agent_settled" });
    expect(f.store.get(task.id).status).toBe("stopped");
  });

  test("natural language completion without a report, model errors, and interrupted reports never become ready", () => {
    for (const failure of ["no-report", "model-error", "crash"]) {
      const f = fixture(); const task = f.task(); const r = f.route(task.id);
      if (failure !== "no-report") f.tool(r, "report", { callId: "r", state: "ready", summary: "完成" });
      if (failure === "model-error") f.service.event(sessionId(r.id), { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "模拟模型失败" } });
      if (failure !== "crash") f.service.event(sessionId(r.id), { type: "agent_settled" });
      f.service.exit(sessionId(r.id));
      expect(f.store.get(task.id).status).toBe("failed");
    }
  });

  test("restart reconciles before dispatch, cancels surviving runs, and ignores duplicate inventory replies", () => {
    const f = fixture(false); const task = f.task();
    expect(f.messages.some(m => m.type === "task_worker_start")).toBe(false);
    f.service.inventory([]);
    const run = f.run(task.id);
    f.service.inventory([run.id]);
    expect(f.run(task.id).status).toBe("starting");
    const restarted = new TaskService(f.store, f.host);
    restarted.inventory([run.id]);
    expect(f.run(task.id).status).toBe("closing");
    expect(() => restarted.tool(run.token, "context", {})).toThrow("结算");
    restarted.exit(sessionId(run.id));
    expect(f.store.get(task.id).status).toBe("failed");
    expect(f.store.get(task.id).summary).toContain("网关已重启");
  });

  test("restart preserves a user's stop, while a missing process becomes retryable", () => {
    const f = fixture(); const t = f.task(); const r = f.run(t.id);
    f.service.request({ action: "stop", actionId: "s", taskId: t.id });
    const restarted = new TaskService(f.store, f.host);
    restarted.inventory([r.id]); restarted.exit(sessionId(r.id));
    expect(f.store.get(t.id).status).toBe("stopped");
    const g = fixture(); const lost = g.task();
    new TaskService(g.store, g.host).inventory([]);
    expect(g.store.get(lost.id).status).toBe("failed");
  });

  test("workers share neither workspace slots nor more than two concurrent slots", () => {
    const f = fixture();
    const a = f.task(); const aw = f.route(a.id);
    const b = f.task(); f.route(b.id);
    expect(f.run(b.id).status).toBe("queued");
    const second = join(f.root, "second"); const third = join(f.root, "third");
    mkdirSync(second); mkdirSync(third);
    const c = f.task(second); f.route(c.id);
    expect(f.run(c.id).status).toBe("starting");
    const d = f.task(third); f.route(d.id);
    expect(f.run(d.id).status).toBe("queued");
    f.tool(aw, "ask", { callId: "ask", question: "确认？" }); f.settle(aw);
    expect(f.run(b.id).status).toBe("starting");
    expect(f.run(d.id).status).toBe("queued");
  });

  test("nested workspaces also serialize and expired runs do not free their slot before exit", () => {
    const f = fixture(); const a = f.task(); const aw = f.route(a.id);
    const nested = join(f.cwd, "nested"); mkdirSync(nested);
    const b = f.task(nested); f.route(b.id);
    expect(f.run(b.id).status).toBe("queued");
    const expired = f.store.get(a.id); activeRun(expired)!.startedAt = "2000-01-01T00:00:00.000Z"; f.store.put(expired);
    f.service.tick();
    expect(f.run(a.id).status).toBe("closing");
    expect(f.run(b.id).status).toBe("queued");
    f.service.exit(sessionId(aw.id));
    expect(f.store.get(a.id).status).toBe("failed");
    expect(f.run(b.id).status).toBe("starting");
  });

  test("role and filesystem gates reject escalation, escaped paths and symlink parents", () => {
    const f = fixture(); const t = f.task(); const router = f.run(t.id);
    expect(() => f.tool(router, "gate", { tool: "bash", input: {} })).toThrow("授权范围");
    expect(() => f.tool(router, "report", { callId: "x", state: "ready", summary: "x" })).toThrow("当前角色");
    const worker = f.route(t.id);
    for (const tool of ["bash", "subagent", "job_start", "ask_user", "mcp_call"]) {
      expect(() => f.tool(worker, "gate", { tool, input: {} })).toThrow("授权范围");
    }
    expect(() => f.tool(worker, "gate", { tool: "write", input: { path: "../escape.txt" } })).toThrow("超出");
    symlinkSync(f.sessionsRoot, join(f.cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(() => f.tool(worker, "gate", { tool: "write", input: { path: "link/new/file.txt" } })).toThrow("超出");
    expect(f.tool(worker, "gate", { tool: "write", input: { path: "new/file.txt" } })).toEqual({ ok: true });
    expect(() => f.tool(worker, "report", { callId: "bad", state: "ready", summary: "done", artifacts: ["missing.txt"] })).toThrow("不存在");
    expect(f.store.get(t.id).status).not.toBe("review");
  });

  test("explicit shell authorization and router clarification retain their scope", () => {
    const f = fixture(); const t = f.task(f.cwd, true); const router = f.run(t.id);
    f.tool(router, "ask", { callId: "q", question: "要整理哪个主题？" }); f.settle(router);
    f.service.request({ action: "answer", actionId: "a", taskId: t.id, questionId: f.store.get(t.id).question!.id, answer: "技术" });
    expect(f.run(t.id).role).toBe("router");
    const worker = f.route(t.id);
    expect(f.tool(worker, "gate", { tool: "bash", input: { command: "pwd" } })).toEqual({ ok: true });
  });

  test("an unanswered question with a missing session is never silently restarted in a blank context", () => {
    const f = fixture(); const t = f.task(); const r = f.run(t.id);
    f.tool(r, "ask", { callId: "q", question: "范围？" }); f.settle(r);
    unlinkSync(r.sessionFile!);
    expect(() => f.service.request({ action: "answer", actionId: "a", taskId: t.id, questionId: f.store.get(t.id).question!.id, answer: "全部" })).toThrow("原任务会话文件不存在");
    expect(f.store.get(t.id).status).toBe("waiting");
    expect(f.store.get(t.id).runs).toHaveLength(1);
  });

  test("a startup failure before session persistence can be explicitly retried without an invalid resume path", () => {
    const f = fixture(); const t = f.task(); const r = f.run(t.id);
    unlinkSync(r.sessionFile!);
    f.service.failed(r.id, "启动失败");
    f.service.request({ action: "retry", actionId: "retry", taskId: t.id });
    expect(f.run(t.id).sessionFile).toBeUndefined();
    expect(f.run(t.id).id).not.toBe(r.id);
    expect(f.store.get(t.id).history.some(h => h.text.includes("未留下可恢复会话"))).toBe(true);
  });
});

describe("todo, dispatch and worker profiles", () => {
  test("a draft parks in todo with no run; dispatch queues a worker with the chosen profile; withdraw returns it before start", () => {
    const f = fixture();
    f.service.request({ action: "create", actionId: "c", prompt: "调研竞品", cwd: f.cwd, allowShell: true, draft: true });
    const t = f.store.all()[0];
    expect(t.status).toBe("todo");
    expect(t.runs).toHaveLength(0);
    expect(f.messages.some(m => m.type === "task_worker_start")).toBe(false);
    f.service.request({ action: "dispatch", actionId: "d", taskId: t.id, profile: "research" });
    // The dispatch tick already claimed the slot, so withdraw is refused once starting.
    expect(f.run(t.id).role).toBe("worker");
    expect(f.run(t.id).profile).toBe("research");
    const start = f.messages.find(m => m.type === "task_worker_start");
    expect(start?.type === "task_worker_start" && start.tools.includes("bash")).toBe(false);
    expect(() => f.service.request({ action: "withdraw", actionId: "w", taskId: t.id })).toThrow("尚未启动");
  });

  test("withdraw succeeds while the run is still queued behind a busy slot", () => {
    const f = fixture();
    const busy = f.task(); f.route(busy.id); // occupies the only workspace slot
    f.service.request({ action: "create", actionId: "c", prompt: "再做一件", cwd: f.cwd, allowShell: false, draft: true });
    const t = f.store.all().find(x => x.status === "todo")!;
    f.service.request({ action: "dispatch", actionId: "d", taskId: t.id });
    expect(f.store.get(t.id).status).toBe("queued");
    expect(f.run(t.id).status).toBe("queued");
    f.service.request({ action: "withdraw", actionId: "w", taskId: t.id });
    expect(f.store.get(t.id).status).toBe("todo");
    expect(f.store.get(t.id).runs.every(r => r.status === "ended")).toBe(true);
    expect(() => f.service.request({ action: "dispatch", actionId: "d2", taskId: busy.id })).toThrow("待办");
  });

  test("the gate follows the run's frozen profile: research never gets bash even with allowShell", () => {
    const f = fixture();
    f.service.request({ action: "create", actionId: "c", prompt: "读资料", cwd: f.cwd, allowShell: true, profile: "research", draft: true });
    const t = f.store.all()[0];
    f.service.request({ action: "dispatch", actionId: "d", taskId: t.id });
    const worker = f.run(t.id);
    expect(() => f.tool(worker, "gate", { tool: "bash", input: { command: "pwd" } })).toThrow("授权范围");
    expect(f.tool(worker, "gate", { tool: "write", input: { path: "report.md" } })).toEqual({ ok: true });
    expect(() => f.service.request({ action: "create", actionId: "x", prompt: "p", cwd: f.cwd, allowShell: false, profile: "admin" })).toThrow("未知执行类型");
  });

  test("retry counts resumes and rows from before profiles default to code", () => {
    const f = fixture(); const t = f.task(); const r = f.run(t.id);
    const legacy = f.store.get(t.id) as unknown as Record<string, unknown>;
    delete legacy.profile; delete legacy.resumeCount;
    f.store.put(legacy as never);
    expect(f.store.get(t.id).profile).toBe("code");
    f.service.failed(r.id, "启动失败");
    f.service.request({ action: "retry", actionId: "r", taskId: t.id });
    expect(f.store.get(t.id).resumeCount).toBe(1);
  });
});
