import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { activeRun, FILE_TOOL_NAMES, object, ORCHESTRATOR_TOOLS, record, runTools, sessionId, text, view, WORKER_PROFILES, type Run, type Task, type TaskRole, type WorkerMessage, type WorkerProfile } from "./model";
import { appendNotice, noticeFor, parseRead, pushMessage, shouldWake, taskLine, wakePrompt } from "./orchestrator";
import { contained, overlaps, workspace } from "./paths";
import { TaskStore } from "./store";

function profileOf(value: unknown, fallback: WorkerProfile): WorkerProfile {
  if (value === undefined) return fallback;
  if (!WORKER_PROFILES.includes(value as WorkerProfile)) throw new Error(`未知执行类型：${String(value)}`);
  return value as WorkerProfile;
}

export interface TaskHost {
  send(message: WorkerMessage): void;
  changed(): void;
  endpoint(): string;
  sessionsRoot: string;
  /** Working directory for the orchestrator process: it has no task directory of its own. */
  orchestratorDir: string;
}

export class TaskService {
  private reconciled = false;
  constructor(readonly store: TaskStore, private host: TaskHost) {}
  /** The orchestrator row is bookkeeping, never a task the person sees. */
  list() {
    return this.store.all().filter(t => t.kind !== "orchestrator")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view);
  }
  /** The existing orchestrator row, without creating one: a gateway with nothing to say stays clean. */
  private existingOrchestrator(): Task | undefined {
    return this.store.all().find(t => t.kind === "orchestrator");
  }

  /** The single global dispatcher, created on first use so an older data dir upgrades in place. */
  orchestrator(): Task {
    const existing = this.existingOrchestrator();
    if (existing) return existing;
    const now = new Date().toISOString();
    const row: Task = {
      id: randomUUID(), kind: "orchestrator", title: "工作台助理", prompt: "", cwd: "",
      allowShell: false, generation: 0, status: "todo", goal: "", acceptance: "", summary: "",
      profile: "research", resumeCount: 0, pending: [], personQueue: [], messages: [],
      artifacts: [], history: [], runs: [], createdAt: now, updatedAt: now,
    };
    this.store.put(row);
    return row;
  }
  start(): void { this.host.send({ type: "task_worker_inspect" }); }

  request(raw: unknown): void {
    const req = object(raw);
    if (req.action === "list") return;
    const actionId = text(req.actionId, "动作 ID", 200);
    this.store.once(actionId, JSON.stringify(req), () => {
      if (req.action === "create") {
        const now = new Date().toISOString();
        const prompt = text(req.prompt, "委托内容");
        if (typeof req.allowShell !== "boolean") throw new Error("请明确是否允许本机命令");
        if (req.draft !== undefined && typeof req.draft !== "boolean") throw new Error("draft 必须是布尔值");
        let parentId: string | undefined;
        if (req.parentId !== undefined) parentId = this.store.get(text(req.parentId, "父任务 ID", 200)).id;
        const task: Task = {
          id: randomUUID(), title: prompt.slice(0, 60), prompt, cwd: workspace(text(req.cwd, "工作目录")),
          allowShell: req.allowShell, generation: 0, status: "todo", goal: "", acceptance: "", summary: "",
          profile: profileOf(req.profile, "code"), resumeCount: 0, ...(parentId ? { parentId } : {}),
          artifacts: [], history: [], runs: [], createdAt: now, updatedAt: now,
        };
        if (req.draft) record(task, "已加入待办；派发后开始执行");
        else {
          record(task, "用户明确委托；等待 Router 确定目标和验收条件");
          this.enqueue(task, "router", prompt);
        }
        this.store.put(task);
        return;
      }
      // Orchestrator actions carry no taskId: they must not reach the task lookup below.
      if (req.action === "orchestrate") {
        this.sayToOrchestrator(text(req.text, "给助理的话", 12000));
        return;
      }
      if (req.action === "orchestrator_answer") {
        const row = this.orchestrator();
        if (!row.question || row.question.id !== req.questionId) throw new Error("问题已过期，请刷新后再回答");
        const answer = text(req.answer, "回答");
        delete row.question;
        row.messages = pushMessage(row.messages, "user", answer);
        row.personQueue = [...(row.personQueue ?? []), answer];
        this.store.put(row);
        this.wake();
        return;
      }
      const task = this.store.get(text(req.taskId, "任务 ID", 200));
      if (req.action === "dispatch") {
        if (task.status !== "todo") throw new Error("只有待办任务可以派发");
        task.profile = profileOf(req.profile, task.profile);
        record(task, `已派发给 Worker（${task.profile}）`);
        this.enqueue(task, "worker", task.prompt);
      } else if (req.action === "withdraw") {
        const run = activeRun(task);
        if (task.status !== "queued" || run?.status !== "queued") throw new Error("只有尚未启动的排队任务可以撤回");
        run.status = "ended";
        run.endedAt = new Date().toISOString();
        task.generation++;
        task.status = "todo";
        record(task, "已撤回到待办");
      } else if (req.action === "answer") {
        if (task.status !== "waiting" || !task.question || task.question.id !== req.questionId) throw new Error("问题已过期或任务仍在结算，请刷新后再回答");
        const answer = text(req.answer, "回答");
        const previous = task.runs.at(-1)!;
        if (!previous.sessionFile || !existsSync(previous.sessionFile)) throw new Error("原任务会话文件不存在，无法恢复回答；请检查数据目录");
        const prompt = `用户回答问题「${task.question.text}」：\n${answer}\n继续原委托，保留原目标及授权边界。`;
        delete task.question;
        record(task, `用户回答：${answer}`);
        this.enqueue(task, previous.role, prompt, previous.sessionFile);
      } else if (req.action === "retry") {
        if (task.status !== "failed") throw new Error("只有失败或中断的任务可重试");
        const previous = task.runs.at(-1)!;
        if (previous.sessionFile && !existsSync(previous.sessionFile)) {
          if (previous.report) throw new Error("已有执行回报但原会话文件丢失，请恢复数据后重试");
          delete previous.sessionFile;
          record(task, "原执行未留下可恢复会话；将根据委托和执行记录恢复，先检查已有成果");
        }
        record(task, "用户明确重试；新建执行尝试");
        task.resumeCount++;
        this.enqueue(task, previous.role, "用户要求恢复原任务。先检查已有成果与失败原因，避免重复副作用，再继续完成验收条件。", previous.sessionFile);
      } else if (req.action === "accept") {
        if (task.status !== "review") throw new Error("成果尚未就绪，不能验收");
        task.status = "completed";
        record(task, "用户已验收成果");
      } else if (req.action === "stop") {
        if (["completed", "stopped"].includes(task.status)) throw new Error("任务已结束");
        const run = activeRun(task);
        task.generation++;
        delete task.question;
        if (run && run.status !== "queued") { task.status = "stopping"; run.status = "closing"; }
        else { if (run) { run.status = "ended"; run.endedAt = new Date().toISOString(); } task.status = "stopped"; }
        record(task, "用户撤销执行资格，停止任务");
      } else throw new Error("未知工作台动作");
      this.store.put(task);
    });
    this.changed();
  }

  /** A person's message to the dispatcher: shown at once, delivered when the current turn ends. */
  private sayToOrchestrator(message: string): void {
    const row = this.orchestrator();
    row.messages = pushMessage(row.messages, "user", message);
    row.personQueue = [...(row.personQueue ?? []), message];
    record(row, "收到用户消息");
    this.store.put(row);
    this.wake();
  }

  /** Append a worker notice and debounce, so a burst of results becomes one turn. */
  private notifyOrchestrator(notice: string): void {
    const row = this.orchestrator();
    row.pending = appendNotice(row.pending ?? [], notice);
    row.lastNoticeAt = new Date().toISOString();
    this.store.put(row);
  }

  /**
   * Start one orchestrator run if it is idle and something is waiting. Notices batch; a person's
   * message never waits for debounce but still waits for the current turn to end.
   */
  private wake(): void {
    // Nothing queued means no wake, and no reason to create the dispatcher row at all.
    const row = this.existingOrchestrator();
    if (!row) return;
    const busy = activeRun(row);
    if (busy?.status === "queued" || busy?.status === "starting") return;
    const pending = row.pending?.length ?? 0;
    const person = row.personQueue?.length ?? 0;
    if (!shouldWake(pending, person, Boolean(busy && busy.status !== "closing"), row.lastNoticeAt, Date.now())) return;
    const prompt = wakePrompt(row.personQueue ?? [], row.pending ?? []);
    row.personQueue = [];
    row.pending = [];
    delete row.lastNoticeAt;
    this.enqueue(row, "orchestrator", prompt, row.sessionFile);
    // The orchestrator row has no lifecycle of its own: it returns to todo between turns.
    row.status = "running";
    this.store.put(row);
  }

  /** What the workbench panel shows: status, the conversation, and any pending question. */
  orchestratorView() {
    const row = this.orchestrator();
    const run = activeRun(row);
    return {
      status: (run ? (run.status === "queued" ? "starting" : run.status === "closing" ? "closing" : "running") : "idle") as "idle" | "starting" | "running" | "closing",
      messages: row.messages ?? [],
      ...(row.question ? { question: row.question } : {}),
      pending: (row.pending?.length ?? 0) + (row.personQueue?.length ?? 0),
    };
  }

  private enqueue(task: Task, role: TaskRole, prompt: string, sessionFile?: string): void {
    if (activeRun(task)) throw new Error("当前执行尚未退出，不能并发启动同一任务");
    task.generation++;
    // Notes ride along with the worker's next run and are then consumed: they grant no authority
    // and never start a run on their own.
    let text = prompt;
    if (role === "worker" && task.notes?.length) {
      text = `${prompt}\n\n助理附注（仅供参考，不扩大授权）：\n${task.notes.map(n => `- ${n}`).join("\n")}`;
      task.notes = [];
    }
    task.runs.push({ id: randomUUID(), token: randomUUID(), generation: task.generation, role, status: "queued", prompt: text, sessionFile, receipts: {},
      ...(role === "worker" ? { profile: task.profile } : {}) });
    task.status = role === "router" ? "routing" : "queued";
    if (role === "orchestrator") task.status = "running";
    task.summary = "";
  }

  /** Inventory must precede dispatch after every gateway restart. */
  inventory(runIds: string[]): void {
    // Multiple outstanding probes may reply after the first reconciliation.
    if (this.reconciled) return;
    const live = new Set(runIds);
    for (const task of this.store.all()) {
      const run = activeRun(task);
      if (!run || run.status === "queued") continue;
      if (live.has(run.id)) {
        // The old HTTP port no longer exists: revoke and stop before offering retry.
        run.error = "网关已重启；已中断旧执行，请明确重试以恢复原上下文";
        run.status = "closing";
        if (task.status !== "stopping") task.status = "settling";
        this.store.put(task);
      } else this.exit(sessionId(run.id));
    }
    for (const id of live) if (!this.store.all().some(t => activeRun(t)?.id === id)) this.host.send({ type: "task_worker_cancel", runId: id });
    this.reconciled = true;
    this.changed();
  }

  started(runId: string): void {
    const found = this.findRun(runId);
    if (!found) { this.host.send({ type: "task_worker_cancel", runId }); return; }
    const { task, run } = found;
    if (task.status === "stopping" || run.status === "closing") { this.host.send({ type: "task_worker_cancel", runId }); return; }
    if (run.status !== "starting") return;
    if (!run.ready) {
      run.error = "任务扩展未就绪，尚未投递委托；请重建引擎 sidecar 后重试";
      run.status = "closing";
      task.status = "settling";
      this.store.put(task);
      this.changed();
      return;
    }
    run.status = "running";
    task.status = run.role === "orchestrator" ? "running" : run.role === "router" ? "routing" : "running";
    record(task, `${run.role === "router" ? "Router" : run.role === "orchestrator" ? "助理" : "Worker"} 引擎已就绪`);
    this.store.put(task);
    this.host.changed();
    this.host.send({ type: "task_worker_prompt", runId, prompt: run.prompt });
  }

  failed(runId: string, error: string): void {
    const found = this.findRun(runId);
    if (!found) return;
    found.run.error = error;
    this.store.put(found.task);
    this.exit(sessionId(runId));
  }

  event(id: string, raw: unknown): boolean {
    if (!id.startsWith("workbench-")) return false;
    const found = this.findRun(id.slice(10));
    if (!found) return true;
    const { task, run } = found;
    const event = object(raw);
    if (event.type === "message_end") {
      const message = object(event.message);
      if (message.role === "assistant" && ["error", "aborted"].includes(String(message.stopReason))) {
        run.error = typeof message.errorMessage === "string" ? message.errorMessage : "模型执行未成功结束";
        this.store.put(task);
      }
    }
    if (event.type === "response" && event.success === false) {
      run.error = typeof event.error === "string" ? event.error : "引擎拒绝了执行请求";
      run.status = "closing";
      this.store.put(task);
      this.changed();
    }
    if (event.type === "agent_settled") {
      run.settled = true;
      run.status = "closing";
      if (task.status !== "stopping") task.status = "settling";
      this.store.put(task);
      this.changed();
    }
    return true;
  }

  exit(id: string): boolean {
    if (!id.startsWith("workbench-")) return false;
    const found = this.findRun(id.slice(10));
    if (!found) return true;
    const { task, run } = found;
    run.status = "ended";
    run.endedAt = new Date().toISOString();
    // The orchestrator row lives on: a finished turn returns it to idle, and a failed turn must not
    // become a "task needing recovery" the person never created. A question it asked must survive,
    // otherwise the panel would have nothing to answer.
    if (task.kind === "orchestrator") {
      task.status = "todo";
      if (run.report?.kind === "question") record(task, "助理提出了问题，等待用户回答");
      else if (run.error) record(task, `助理本轮未完成：${run.error}`);
      this.store.put(task);
      this.changed();
      this.wake();
      return true;
    }
    if (task.status === "stopping") { task.status = "stopped"; record(task, "执行器已退出，任务已停止"); }
    else if (run.error || !run.settled || !run.report) {
      task.status = "failed";
      task.summary = run.error || "执行中断或没有结构化交付；请检查 sidecar 版本后重试";
      record(task, task.summary);
    } else if (run.report.kind === "question") {
      task.status = "waiting"; record(task, "问题已登记；执行槽已释放，等待用户回答");
    } else if (run.report.kind === "create") {
      this.enqueue(task, "worker", task.prompt);
      record(task, "Router 已确认目标与验收条件；等待 Worker");
    } else {
      task.status = run.report.kind === "ready" ? "review" : run.report.kind === "ignore" ? "completed" : "failed";
      task.summary = run.report.summary;
      record(task, task.status === "review" ? "Worker 已结算，成果等待验收" : task.summary);
    }
    this.store.put(task);
    // Only states a person must act on reach the orchestrator; routine progress stays in the task.
    const notice = noticeFor(task, task.summary || run.report?.summary || "");
    if (notice) this.notifyOrchestrator(notice);
    this.changed();
    return true;
  }

  tick(): void {
    if (!this.reconciled) { this.start(); return; }
    const tasks = this.store.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let routers = 0, workers = 0, orchestrators = 0;
    const busy = new Set<string>();
    for (const task of tasks) {
      const run = activeRun(task);
      if (!run || run.status === "queued") continue;
      if (run.role === "orchestrator") orchestrators++;
      else if (run.role === "router") routers++;
      else { workers++; busy.add(task.cwd); }
      if (run.startedAt && Date.now() - Date.parse(run.startedAt) > 15 * 60_000 && run.status !== "closing") {
        run.error = "执行超过 15 分钟，已请求中止；可检查进度后重试";
        run.status = "closing";
        task.status = task.kind === "orchestrator" ? "todo" : "settling";
        this.store.put(task);
        this.host.changed();
      }
      if (run.status === "closing") this.host.send({ type: "task_worker_cancel", runId: run.id });
    }
    for (const task of tasks) {
      const run = activeRun(task);
      if (run?.status !== "queued") continue;
      if (run.role === "orchestrator") {
        // One global dispatcher, never serialized against a task's workspace.
        if (orchestrators >= 1) continue;
        orchestrators++;
      } else if (run.role === "router" ? routers >= 1 : workers >= 2 || [...busy].some(cwd => overlaps(cwd, task.cwd))) continue;
      else if (run.role === "router") routers++; else { workers++; busy.add(task.cwd); }
      run.status = "starting";
      run.startedAt = new Date().toISOString();
      this.store.put(task); // durable dispatch intention before the side effect
      try {
        this.host.send({ type: "task_worker_start", taskId: task.id, runId: run.id, role: run.role,
          cwd: task.kind === "orchestrator" ? this.host.orchestratorDir : task.cwd, sessionFile: run.sessionFile,
          endpoint: this.host.endpoint(), token: run.token, allowShell: task.allowShell, tools: runTools(run, task) });
      } catch (error) { this.failed(run.id, `派发失败：${String(error)}`); }
    }
    // Notices wait out their debounce here, so a burst of worker results becomes one wake turn.
    this.wake();
  }

  /** Per-run bearer identity, not a model-supplied taskId. */
  tool(token: string, operation: string, raw: unknown): unknown {
    const found = this.store.all().map(task => ({ task, run: activeRun(task) })).find(x => x.run?.token === token);
    if (!found?.run) throw new Error("执行凭据已失效");
    const { task, run } = found;
    if (run.generation !== task.generation || !["starting", "running"].includes(run.status) || task.status === "stopping") throw new Error("任务已停止或正在结算");
    const body = object(raw);
    if (operation === "context") {
      if (body.protocol !== undefined) {
        if (body.protocol !== 1 || body.role !== run.role) throw new Error("任务扩展协议或角色不匹配");
        run.ready = true;
      }
      if (typeof body.sessionFile === "string") {
        run.sessionFile = contained(join(this.host.sessionsRoot, task.id), body.sessionFile);
        if (run.role === "worker" || run.role === "orchestrator") task.sessionFile = run.sessionFile;
      }
      this.store.put(task);
      if (run.role === "orchestrator") return this.orchestratorContext(task);
      return { role: run.role, prompt: task.prompt, goal: task.goal, acceptance: task.acceptance, cwd: task.cwd,
        allowShell: task.allowShell, profile: run.profile ?? task.profile, tools: runTools(run, task), history: task.history.slice(-12) };
    }
    if (operation === "gate") {
      const name = text(body.tool, "工具", 80);
      // Same source as the start message: what the engine activates is exactly what the gate accepts.
      if (!runTools(run, task).includes(name) || run.report) throw new Error("工具不在本次授权范围，或本轮已交付/提问");
      const input = object(body.input);
      if (FILE_TOOL_NAMES.includes(name)) contained(task.cwd, typeof input.path === "string" ? input.path : ".");
      return { ok: true };
    }
    const callId = text(body.callId, "调用 ID", 200);
    const fingerprint = JSON.stringify({ operation, body });
    if (run.receipts[callId]) {
      if (run.receipts[callId] !== fingerprint) throw new Error("调用 ID 内容冲突");
      return { recorded: true };
    }
    if (run.report) throw new Error("本轮已有交付或问题，请结束当前轮");
    if (run.role === "orchestrator") {
      // The dispatcher's protocol: create work, hand a fact, deliver to the person, ask the person.
      // It never reports on a task it does not own, so those operations are unreachable here.
      const values = this.orchestratorTool(run, body, operation);
      if (operation === "ask" || operation === "reply") {
        task.status = "settling";
        run.report = { kind: operation === "ask" ? "question" : "ready", summary: values as string };
      } else run.receipts[callId] = fingerprint;
      this.store.put(task);
      this.host.changed();
      return { recorded: true, ...(values && typeof values === "object" ? values : { result: values }),
        instruction: "已登记。本轮到此为止，不要继续调用工具。" };
    }
    if (operation === "ask") {
      const question = text(body.question, "问题", 2000);
      const options = body.options === undefined ? [] : body.options;
      if (!Array.isArray(options) || options.length > 5 || options.some(v => typeof v !== "string" || v.length > 200)) throw new Error("问题选项格式错误");
      task.question = { id: randomUUID(), text: question, options };
      run.report = { kind: "question", summary: question };
      record(task, `等待执行结算后提问：${question}`);
    } else if (operation === "decide" && run.role === "router") {
      const decision = body.decision;
      if (decision !== "create" && decision !== "ignore") throw new Error("Router 决策必须是 create 或 ignore；澄清请用 task_ask");
      if (decision === "create") {
        task.title = text(body.title, "标题", 160);
        task.goal = text(body.goal, "目标", 4000);
        task.acceptance = text(body.acceptance, "验收条件", 4000);
      }
      run.report = { kind: decision, summary: text(body.reason, "决策理由", 2000) };
      record(task, `Router：${run.report.summary}`);
    } else if (operation === "report" && run.role === "worker") {
      if (!["ready", "failed"].includes(String(body.state))) throw new Error("交付状态必须是 ready 或 failed");
      const summary = text(body.summary, "交付摘要", 24000);
      const paths = body.artifacts ?? [];
      if (!Array.isArray(paths) || paths.length > 20) throw new Error("成果文件最多 20 个");
      task.artifacts = paths.map(value => {
        const path = contained(task.cwd, text(value, "成果路径"), true);
        if (!statSync(path).isFile()) throw new Error("成果必须是文件");
        return { path, name: basename(path) };
      });
      task.summary = summary;
      run.report = { kind: body.state as "ready" | "failed", summary };
    } else throw new Error("当前角色不能调用此任务动作");
    task.status = "settling";
    run.receipts[callId] = fingerprint;
    this.store.put(task);
    this.host.changed();
    return { recorded: true, instruction: "已登记。请结束当前轮，不再执行工具；用户回答会在新的运行中送达。" };
  }

  private findRun(runId: string): { task: Task; run: Run } | undefined {
    for (const task of this.store.all()) { const run = activeRun(task); if (run?.id === runId) return { task, run }; }
    return undefined;
  }
  private changed(): void { this.host.changed(); this.tick(); }

  /** What the dispatcher may know: task lines, never files, transcripts or worker internals. */
  private orchestratorContext(row: Task): unknown {
    const tasks = this.store.all().filter(t => t.kind !== "orchestrator");
    const active = tasks.filter(t => ["routing", "queued", "running", "settling", "stopping"].includes(t.status));
    return {
      role: "orchestrator",
      workspaces: [...new Set(tasks.map(t => t.cwd))].slice(-20),
      counts: {
        todo: tasks.filter(t => t.status === "todo").length,
        active: active.length,
        attention: tasks.filter(t => ["waiting", "review", "failed"].includes(t.status)).length,
      },
      pending: row.pending ?? [],
      tools: runTools({ role: "orchestrator" }, row),
    };
  }

  /**
   * The dispatcher's whole protocol. Every operation is bounded here, not in the prompt:
   * it can read task lines, create and dispatch work, hand a worker one fact, and talk to the
   * person. It cannot read files, run commands, resume a stopped task or accept a result.
   */
  private orchestratorTool(run: Run, body: Record<string, unknown>, operation: string): unknown {
    if (operation === "read") {
      const request = parseRead({
        resource: typeof body.resource === "string" ? body.resource : "",
        ...(typeof body.offset === "number" ? { offset: body.offset } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
      if (request.resource === "profile") return { profile: "orchestrator", tools: ORCHESTRATOR_TOOLS };
      if (request.resource === "task") {
        const task = this.store.get(request.id!);
        if (task.kind === "orchestrator") throw new Error("不能读取助理自身作为任务");
        return {
          task: { ...taskLine(task), goal: task.goal, acceptance: task.acceptance, summary: task.summary,
            cwd: task.cwd, allowShell: task.allowShell, resumeCount: task.resumeCount,
            question: task.question?.text },
          history: task.history.slice(-request.limit).map(h => h.text),
          runs: task.runs.slice(-8).map(r => ({ role: r.role, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, error: r.error })),
        };
      }
      const all = this.store.all().filter(t => t.kind !== "orchestrator")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const page = all.slice(request.offset, request.offset + request.limit).map(taskLine);
      return {
        tasks: page, total: all.length,
        ...(request.offset + page.length < all.length ? { next_offset: request.offset + page.length } : {}),
      };
    }
    if (operation === "route") {
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 10)
        throw new Error("task_route 需要 1~10 个任务项");
      // Each item stands alone: one refused item never discards the others.
      return {
        results: body.items.map((raw, index) => {
          try {
            return { index, task: this.createFromRoute(object(raw)) };
          } catch (error) {
            return { index, error: String(error instanceof Error ? error.message : error) };
          }
        }),
      };
    }
    if (operation === "note") {
      const id = text(body.taskId, "任务 ID", 200);
      const note = text(body.text, "附注", 300);
      const task = this.store.get(id);
      if (task.kind === "orchestrator") throw new Error("不能给自己写附注");
      if (["completed", "stopped"].includes(task.status)) throw new Error("任务已结束，附注不会送达");
      // A note grants no authority: it rides along with the worker's next run, it does not start one.
      task.notes = [...(task.notes ?? []), note].slice(-5);
      record(task, `助理附注：${note}`);
      this.store.put(task);
      return { recorded: true, task: taskLine(task) };
    }
    if (operation === "reply") {
      const purpose = body.purpose;
      if (purpose !== "result" && purpose !== "attention" && purpose !== "answer")
        throw new Error("task_reply 的 purpose 只能是 result、attention 或 answer；进度不要汇报");
      const reply = text(body.text, "回复", 4000);
      if (purpose === "attention" && !body.taskId) throw new Error("attention 需要指向具体任务");
      const row = this.orchestrator();
      row.messages = pushMessage(row.messages, "orchestrator", reply);
      this.store.put(row);
      return reply;
    }
    if (operation === "ask") {
      const question = text(body.question, "问题", 2000);
      const options = body.options === undefined ? [] : body.options;
      if (!Array.isArray(options) || options.length > 5 || options.some(v => typeof v !== "string" || v.length > 200))
        throw new Error("问题选项格式错误");
      const row = this.orchestrator();
      row.question = { id: randomUUID(), text: question, options };
      row.messages = pushMessage(row.messages, "orchestrator", question);
      this.store.put(row);
      return question;
    }
    throw new Error("助理不能调用此操作");
  }

  /** Create one task from a route item. Validation is per item so a batch can partially succeed. */
  private createFromRoute(item: Record<string, unknown>) {
    const prompt = text(item.prompt, "委托内容", 12000);
    const now = new Date().toISOString();
    const profile = profileOf(item.profile, "code");
    const allowShell = item.allowShell === true;
    if (profile === "research" && allowShell) throw new Error("调研类任务不能开放本机命令");
    let parentId: string | undefined;
    if (item.parentId !== undefined) parentId = this.store.get(text(item.parentId, "父任务 ID", 200)).id;
    const task: Task = {
      id: randomUUID(), title: text(item.title ?? prompt.slice(0, 60), "标题", 160),
      prompt, cwd: workspace(text(item.cwd, "工作目录")),
      goal: item.goal === undefined ? "" : text(item.goal, "目标", 4000),
      acceptance: item.acceptance === undefined ? "" : text(item.acceptance, "验收条件", 4000),
      allowShell, generation: 0, status: "todo", summary: "",
      profile, resumeCount: 0, ...(parentId ? { parentId } : {}),
      artifacts: [], history: [], runs: [], createdAt: now, updatedAt: now,
    };
    record(task, "助理接单");
    // Dispatch by default: the point of routing is that work starts without another round trip.
    if (item.dispatch !== false) {
      record(task, `已派发给 Worker（${profile}）`);
      this.enqueue(task, "worker", prompt);
    }
    this.store.put(task);
    return taskLine(task);
  }
}
