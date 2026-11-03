import type { ScriptSpec } from "./code-types";

export interface ExperimentDraft { id: string; updatedAt: string; spec: ScriptSpec }
export type CodeView = { kind: "create" | "records" } | { kind: "edit" | "report"; id: string };
export const draftStorageKey = "kalo.investment.experiments.v1";

export function isScriptSpec(value: unknown): value is ScriptSpec {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return ["datasetId", "title", "source", "start", "end"].every(k => typeof s[k] === "string") &&
    ["cash", "basePosition", "tradeSize", "commissionBps", "minimumFee", "slippageBps"].every(k => typeof s[k] === "number" && Number.isFinite(s[k]));
}

// Reject the whole invalid library: silently filtering entries could destroy drafts on the next save.
export function parseDrafts(raw: string | null): ExperimentDraft[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("drafts" in value) || !Array.isArray(value.drafts)) throw new Error("草稿库格式不受支持");
  const ids = new Set<string>();
  for (const d of value.drafts) {
    if (!d || typeof d.id !== "string" || !d.id || ids.has(d.id) || typeof d.updatedAt !== "string" || !Number.isFinite(Date.parse(d.updatedAt)) || !isScriptSpec(d.spec)) throw new Error("草稿库包含无法读取的实验");
    ids.add(d.id);
  }
  return value.drafts;
}

export function putDraft(drafts: ExperimentDraft[], draft: ExperimentDraft): ExperimentDraft[] {
  return [draft, ...drafts.filter(d => d.id !== draft.id)];
}

export function copyExperiment(id: string, updatedAt: string, spec: ScriptSpec): ExperimentDraft {
  return { id, updatedAt, spec: { ...spec } };
}
