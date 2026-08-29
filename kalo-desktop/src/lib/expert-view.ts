import type { Expert, RunningJobSession, ScheduleTaskInfo } from "../types";

/**
 * Pure view helpers behind the 数字专家 panel
 * (doc/2026-08-29-digital-experts.md): the registry, jobs_list's running
 * sessions and the schedule table are aggregated into per-expert card and
 * detail view models. No Tauri IPC here — the panel feeds in snapshots it
 * already loaded, so the selection and formatting rules stay testable.
 */

/** One card in the expert list. */
export interface ExpertCardView {
  expert: Expert;
  /** Running sessions (desktop + gateway) bound to this expert. */
  runningCount: number;
  /** Enabled scheduled tasks bound to this expert. */
  enabledTaskCount: number;
  /** Earliest next run among the enabled tasks; null when none is scheduled. */
  nextRunAt: string | null;
}

/** One running session row in the expert detail. */
export interface ExpertSessionRow {
  id: string;
  name: string;
  /** Session title from the on-disk JSONL, when it exists (falls back to name). */
  title?: string;
  /** 桌面 | 定时 — same labels as the job center. */
  sourceLabel: string;
  cwd: string;
  /** Unix seconds (string), as reported by jobs_list. */
  startedAt: string;
}

/** One scheduled-task row in the expert detail. */
export interface ExpertTaskRow {
  id: string;
  name: string;
  kind: string;
  schedule: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastResult?: string;
}

/** Flatten list_sessions groups into a sessionId → title lookup. */
export function sessionTitles(groups: { sessions: { id: string; title: string }[] }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of groups) {
    for (const s of g.sessions) {
      if (s.title && !map.has(s.id)) map.set(s.id, s.title);
    }
  }
  return map;
}

export interface ExpertDetailView {
  sessions: ExpertSessionRow[];
  tasks: ExpertTaskRow[];
}

/** ISO timestamp -> local "MM-dd HH:mm"; empty -> "—", unparsable -> as-is. */
export function fmtNextRun(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Unix-seconds string (jobs_list startedAt) -> local "MM-dd HH:mm"; invalid -> "—". */
export function fmtStartedAt(unixSecs: string): string {
  const n = Number(unixSecs);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return fmtNextRun(new Date(n * 1000).toISOString());
}

/**
 * Where the expert's memory files live — the directory `KALO_MEMORY_DIR`
 * points at for this expert's sessions. Trailing separators are stripped so
 * list_dir never sees a doubled slash.
 */
export function memoryDirPath(workdir: string): string {
  return `${workdir.replace(/[\\/]+$/, "")}/.kalo/memory`;
}

/** Job-center source value -> the label both surfaces share. */
export function sessionSourceLabel(source: string): string {
  return source === "gateway" ? "定时" : "桌面";
}

/** One-line mission summary for the card: first non-empty line, capped. */
export function missionSummary(mission: string, max = 60): string {
  const line = mission.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * One card per expert, in registry order. `nextRunAt` only considers enabled
 * tasks: a disabled task's stale nextRunAt must not surface as the expert's
 * next trigger.
 */
export function expertCards(
  experts: Expert[],
  running: RunningJobSession[],
  tasks: ScheduleTaskInfo[],
): ExpertCardView[] {
  return experts.map((expert) => {
    const id = expert.id;
    const runningCount = running.filter((s) => s.expertId === id).length;
    const enabled = tasks.filter((t) => t.expertId === id && t.enabled);
    const nextRunAt =
      enabled
        .map((t) => t.nextRunAt)
        .filter((x): x is string => typeof x === "string")
        .sort()[0] ?? null;
    return { expert, runningCount, enabledTaskCount: enabled.length, nextRunAt };
  });
}

/** The detail pane's two read-only sections, both filtered to one expert. */
export function expertDetail(
  expertId: string,
  running: RunningJobSession[],
  tasks: ScheduleTaskInfo[],
  /** sessionId → title, from list_sessions; lets rows show the real session title. */
  titles?: Map<string, string>,
): ExpertDetailView {
  return {
    sessions: running
      .filter((s) => s.expertId === expertId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        title: titles?.get(s.id),
        sourceLabel: sessionSourceLabel(s.source),
        cwd: s.cwd,
        startedAt: s.startedAt,
      })),
    tasks: tasks
      .filter((t) => t.expertId === expertId)
      .map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        schedule: t.schedule,
        enabled: t.enabled,
        nextRunAt: t.nextRunAt,
        lastResult: t.lastResult,
      })),
  };
}
