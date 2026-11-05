/** Pure, fail-closed parsing of the optional ERA acceptance protocol. */
export interface AcceptanceStage {
  nodeId: number;
  scope: string;
  stage: string;
  level: string;
  status: string;
  reason: string;
  checks: string[];
}

export interface AcceptedArtifact {
  nodeId: number;
  path: "accepted";
  contractId: string;
  candidateHash: string;
}

export interface AcceptanceRequirement { name: string; level: string; checks: string[] }

export function parseRequirements(value: unknown): AcceptanceRequirement[] {
  if (!Array.isArray(value) || !value.length) return [];
  const result: AcceptanceRequirement[] = [];
  for (const item of value) {
    const s = object(item);
    if (typeof s.name !== "string" || !s.name || !["quick", "full"].includes(String(s.level)) ||
        !Array.isArray(s.checks) || !s.checks.length || s.checks.some((c) => typeof c !== "string" || !c) ||
        result.some((r) => r.name === s.name)) return [];
    result.push({ name: s.name, level: s.level as string, checks: s.checks as string[] });
  }
  return result.some((s) => s.level === "full") ? result : [];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function parseAcceptanceStage(value: unknown): AcceptanceStage {
  const r = object(value);
  return {
    nodeId: typeof r.node_id === "number" ? r.node_id : -1,
    scope: typeof r.scope === "string" ? r.scope : "final",
    stage: typeof r.stage === "string" ? r.stage : "未知检查",
    level: typeof r.level === "string" ? r.level : "unknown",
    status: typeof r.status === "string" ? r.status : "INFRA_ERROR",
    reason: typeof r.reason === "string" ? r.reason : "",
    checks: Array.isArray(r.checks_completed) ? r.checks_completed.filter((v): v is string => typeof v === "string") : [],
  };
}

export function parseAcceptanceResult(value: unknown, artifact: unknown, contractId: string | null,
                                      required: AcceptanceRequirement[] = []) {
  const result = object(value);
  const a = object(artifact);
  const stages = Array.isArray(result.stages) ? result.stages.map(parseAcceptanceStage) : [];
  let status = typeof result.status === "string" ? result.status : "NOT_CONFIGURED";
  let reason = typeof result.reason === "string" ? result.reason : "";
  let accepted: AcceptedArtifact | null = null;
  if (status === "PASS") {
    const hash = typeof a.candidate_hash === "string" && /^[a-f0-9]{64}$/.test(a.candidate_hash);
    if (contractId && a.contract_id === contractId && result.contract_id === contractId &&
        hash && a.candidate_hash === result.candidate_hash &&
        Number.isInteger(a.node_id) && a.node_id === result.node_id && a.path === "accepted" &&
        stages.length > 0 && stages.every((s) => s.status === "PASS" && s.checks.length > 0) &&
        stages.some((s) => s.level === "full") && required.length === stages.length &&
        required.every((r, i) => stages[i].stage === r.name && stages[i].level === r.level &&
          r.checks.every((c) => stages[i].checks.includes(c)))) {
      accepted = { nodeId: a.node_id as number, path: "accepted", contractId, candidateHash: a.candidate_hash as string };
    } else {
      status = "INFRA_ERROR";
      reason = "验收记录缺少完整检查或产物指纹，不能确认通过";
    }
  }
  return { status, reason, accepted };
}

export function acceptanceLabel(status: string): string {
  return ({ NOT_CONFIGURED: "未配置验收", NOT_RUN: "尚未验收", RUNNING: "验收中",
    PASS: "已通过完整验收", FAIL: "验收未通过", INCONCLUSIVE: "证据不足",
    INFRA_ERROR: "验收异常" } as Record<string, string>)[status] ?? "状态未知";
}
