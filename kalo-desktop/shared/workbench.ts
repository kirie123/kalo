/** Workbench wire contract. No runtime, filesystem or IPC dependencies. */
export type TaskStatus = "routing" | "queued" | "running" | "settling" | "waiting" | "review" | "completed" | "failed" | "stopping" | "stopped";
export type TaskRole = "router" | "worker";
export interface TaskQuestion { id: string; text: string; options: string[] }
export interface TaskArtifact { path: string; name: string }
export interface TaskHistory { at: string; text: string }
export interface TaskView {
  id: string; title: string; prompt: string; cwd: string; allowShell: boolean;
  status: TaskStatus; goal: string; acceptance: string; summary: string;
  question?: TaskQuestion; artifacts: TaskArtifact[]; history: TaskHistory[];
  createdAt: string; updatedAt: string; sessionFile?: string;
  runs: { id: string; role: TaskRole; status: string }[];
}
export type WorkbenchRequest =
  | { action: "list" }
  | { action: "create"; actionId: string; prompt: string; cwd: string; allowShell: boolean }
  | { action: "answer"; actionId: string; taskId: string; questionId: string; answer: string }
  | { action: "retry" | "stop" | "accept"; actionId: string; taskId: string };
export interface WorkbenchReply { ok: boolean; tasks?: TaskView[]; error?: string }
