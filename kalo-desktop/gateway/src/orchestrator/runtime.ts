import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../credentials";
import { TaskStore } from "./store";
import { TaskService } from "./service";
import { object, type WorkerMessage } from "./model";

export class TaskRuntime {
  readonly service: TaskService;
  private server: ReturnType<typeof Bun.serve>;
  private timer: ReturnType<typeof setInterval>;
  constructor(private emit: (message: WorkerMessage | Record<string, unknown>) => void, agentDirectory = agentDir) {
    const dir = join(agentDirectory, "orchestrator");
    mkdirSync(dir, { recursive: true });
    // The dispatcher has no task directory: it needs an existing cwd but never touches files there.
    const orchestratorDir = join(dir, "workspace");
    mkdirSync(orchestratorDir, { recursive: true });
    const store = new TaskStore(join(dir, "tasks.sqlite"));
    this.service = new TaskService(store, {
      send: message => emit(message), changed: () => emit({ type: "workbench_changed" }),
      endpoint: () => `http://127.0.0.1:${this.server.port}`,
      sessionsRoot: join(agentDirectory, "task-sessions"),
      orchestratorDir,
    });
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 128 * 1024, fetch: req => this.toolRequest(req) });
    this.timer = setInterval(() => {
      try { this.service.tick(); } catch (error) { console.error("[workbench] dispatch:", String(error)); }
    }, 2000);
    this.service.start();
  }
  private async toolRequest(req: Request): Promise<Response> {
    try {
      if (req.method !== "POST" || req.headers.has("origin")) return Response.json({ error: "请求不允许" }, { status: 403 });
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!token) return Response.json({ error: "缺少执行凭据" }, { status: 401 });
      const operation = new URL(req.url).pathname.slice(1);
      const body: unknown = await req.json();
      const result = this.service.store.atomic(() => this.service.tool(token, operation, body));
      return Response.json(result);
    } catch (error) { return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 400 }); }
  }
  handle(raw: unknown): boolean {
    const cmd = object(raw);
    switch (cmd.cmd) {
      case "workbench_request":
        try {
          this.service.request(cmd.request);
          this.emit({ type: "workbench_reply", requestId: cmd.requestId, ok: true,
            tasks: this.service.list(), orchestrator: this.service.orchestratorView() });
        } catch (error) { this.emit({ type: "workbench_reply", requestId: cmd.requestId, ok: false, error: String(error instanceof Error ? error.message : error) }); }
        return true;
      case "task_worker_started": this.service.started(String(cmd.runId)); return true;
      case "task_worker_failed": this.service.failed(String(cmd.runId), String(cmd.error)); return true;
      case "task_worker_inventory": {
        if (!Array.isArray(cmd.runIds) || cmd.runIds.some(id => typeof id !== "string")) throw new Error("无效的 Worker 清单");
        this.service.inventory(cmd.runIds); return true;
      }
      case "event": return this.service.event(String(cmd.sessionId), cmd.payload);
      case "session_exit": return this.service.exit(String(cmd.sessionId));
      default: return false;
    }
  }
  close(): void { clearInterval(this.timer); this.server.stop(true); this.service.store.close(); }
}
