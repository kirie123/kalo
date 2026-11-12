/** Workbench wire contract. No runtime, filesystem or IPC dependencies. */
export type TaskStatus = "todo" | "routing" | "queued" | "running" | "settling" | "waiting" | "review" | "completed" | "failed" | "stopping" | "stopped";
/** `orchestrator` is the dispatcher role. It is named after the domain job, never `assistant`:
 *  the engine already uses "assistant" for the model's message role and reusing it would collide. */
export type TaskRole = "orchestrator" | "worker" | "router";
/** Which tool set a worker may use. Decided by the assistant at dispatch, enforced by the gateway gate. */
export type WorkerProfile = "research" | "code" | "data";
export const WORKER_PROFILES: readonly WorkerProfile[] = ["research", "code", "data"];
export interface TaskQuestion { id: string; text: string; options: string[] }
export interface TaskArtifact { path: string; name: string }
export interface TaskHistory { at: string; text: string }
export interface TaskView {
  id: string; title: string; prompt: string; cwd: string; allowShell: boolean;
  status: TaskStatus; goal: string; acceptance: string; summary: string;
  question?: TaskQuestion; artifacts: TaskArtifact[]; history: TaskHistory[];
  createdAt: string; updatedAt: string; sessionFile?: string;
  profile: WorkerProfile;
  parentId?: string;
  resumeCount: number;
  runs: { id: string; role: TaskRole; status: string; profile?: WorkerProfile; startedAt?: string; endedAt?: string }[];
}
export type WorkbenchRequest =
  | { action: "list" }
  /** draft=true parks the task in todo; otherwise it starts routing immediately. */
  | { action: "create"; actionId: string; prompt: string; cwd: string; allowShell: boolean; profile?: WorkerProfile; parentId?: string; draft?: boolean }
  /** todo → queued worker run. withdraw: queued → todo, before any process starts. */
  | { action: "dispatch"; actionId: string; taskId: string; profile?: WorkerProfile }
  | { action: "withdraw"; actionId: string; taskId: string }
  | { action: "answer"; actionId: string; taskId: string; questionId: string; answer: string }
  | { action: "retry" | "stop" | "accept"; actionId: string; taskId: string }
  /** Send a message to the orchestrator session; it answers and may route work. */
  | { action: "orchestrate"; actionId: string; text: string }
  | { action: "orchestrator_answer"; actionId: string; questionId: string; answer: string };
export type OrchestratorStatus = "idle" | "starting" | "running" | "closing";
export interface OrchestratorMessage { at: string; role: "user" | "orchestrator"; text: string }
export interface OrchestratorView {
  status: OrchestratorStatus;
  messages: OrchestratorMessage[];
  question?: TaskQuestion;
  /** Events batched for the next wake, so the panel can show work in flight. */
  pending: number;
}
export interface WorkbenchReply { ok: boolean; tasks?: TaskView[]; orchestrator?: OrchestratorView; error?: string }
