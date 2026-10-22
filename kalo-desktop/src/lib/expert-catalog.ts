import type { Expert } from "../types";

export type ExpertKindFilter = "all" | "agent" | "team";

export function expertDefinitionDir(expert: Expert): string {
  return expert.definitionDir || expert.workdir || "";
}

/** Resource directories are never selected as task output directories implicitly. */
export function needsExpertWorkspace(cwd: string, experts: Expert[]): boolean {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const current = normalize(cwd.trim());
  if (!current) return true;
  return experts.some((expert) => {
    const root = normalize(expertDefinitionDir(expert));
    return root !== "" && (current === root || current.startsWith(`${root}/`));
  });
}

export function filterExperts(experts: Expert[], query = "", kind: ExpertKindFilter = "all"): Expert[] {
  const term = query.trim().toLowerCase();
  return experts.filter((expert) =>
    (kind === "all" || (expert.kind ?? "agent") === kind)
    && (!term || [expert.name, expert.id, expert.mission, ...(expert.members ?? []).flatMap((m) => [m.name, m.profession, m.id])]
      .some((text) => text.toLowerCase().includes(term))),
  );
}
