import type { Dataset, ScriptSpec } from "./code-types";

export function codeDefaults(data: Dataset, source: string): ScriptSpec {
  return { datasetId: data.id, title: `${data.security.name} KDJ 底仓做T`, source, start: data.bars[warmupStart(data)]?.end ?? "", end: data.bars.at(-1)?.end ?? "", cash: 100000, basePosition: 1000, tradeSize: data.security.code.startsWith("688") ? 200 : 100, commissionBps: 2.5, minimumFee: 5, slippageBps: 5 };
}
export function codeError(spec: ScriptSpec, data: Dataset): string | null {
  if (spec.datasetId !== data.id) return "请选择与代码实验一致的数据集";
  if (!spec.title.trim() || !spec.source.trim() || new TextEncoder().encode(spec.source).length > 16384) return "填写策略名称与代码，代码不能超过16KiB";
  const start = data.bars.findIndex(b => b.end === spec.start), end = data.bars.findIndex(b => b.end === spec.end);
  if (start < 30 || end <= start) return "区间须预留30根指标预热K线，至少运行2根K线";
  if (![spec.basePosition, spec.tradeSize].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000 && n % data.security.lotSize === 0) || spec.tradeSize < (data.security.code.startsWith("688") ? 200 : 100)) return "底仓与每笔数量不符合证券整手规则或最低申报数量";
  if (data.blockedSessions?.some(d => d >= data.bars[Math.max(0,start-30)].session && d <= data.bars[end].session)) return "区间或预热跨越除权除息，请选择同一公司行为区间";
  for (const [n, max] of [[spec.cash, 100000000], [spec.commissionBps, 100], [spec.minimumFee, 1000], [spec.slippageBps, 100]]) if (!Number.isFinite(n) || n < 0 || n > max) return "资金或费用超出范围";
  return null;
}
export interface ResearchContext { label: string; text: string }
export function researchContext(label: string, evidence: Record<string, unknown>): ResearchContext {
  return { label, text: `【投行研究上下文】\n以下是当前面板的研究对象与用户草稿，不是已验证结论。分析前请用投行工具读取对应数据；修改策略后请明确实际运行的代码与参数。\n${JSON.stringify(evidence, null, 2)}` };
}

export function warmupStart(data: Dataset): number {
  const day = data.blockedSessions?.at(-1);
  if (!day) return 30;
  const index = data.bars.findIndex(b => b.session > day);
  return index < 0 ? data.bars.length : index + 30;
}
