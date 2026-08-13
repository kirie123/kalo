/**
 * Pinned project list, persisted in localStorage under `kalo.projects`.
 * Projects are pure UI bookmarks (name + cwd); session files stay on disk
 * and are matched to projects by cwd.
 */

export interface ProjectEntry {
  name: string;
  cwd: string;
}

const KEY = "kalo.projects";

export function listProjects(): ProjectEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is ProjectEntry =>
        typeof p === "object" && p !== null &&
        typeof (p as ProjectEntry).name === "string" &&
        typeof (p as ProjectEntry).cwd === "string",
    );
  } catch {
    return [];
  }
}

function save(list: ProjectEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Add a project; an existing entry with the same cwd is replaced. */
export function addProject(entry: ProjectEntry) {
  const list = listProjects().filter((p) => p.cwd !== entry.cwd);
  list.push(entry);
  save(list);
}

export function removeProject(cwd: string) {
  save(listProjects().filter((p) => p.cwd !== cwd));
}

/** Last path segment of a cwd, tolerant of both separators. */
export function cwdBasename(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/** Normalize a cwd for equality checks (separators + trailing slash + case). */
export function normalizeCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}
