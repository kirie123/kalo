import type { Dataset, ScriptSpec } from "./code-types";

export function codeDefaults(data: Dataset, source: string): ScriptSpec {
  return { datasetId: data.id, title: "海康威视 KDJ 底仓做T", source, start: data.bars[30]?.end ?? "", end: data.bars.at(-1)?.end ?? "", cash: 100000, basePosition: 1000, tradeSize: 100, commissionBps: 2.5, minimumFee: 5, slippageBps: 5 };
}
export function codeError(spec: ScriptSpec, data: Dataset): string | null {
  if (spec.datasetId !== data.id) return "请选择与代码实验一致的数据集";
  if (!spec.title.trim() || !spec.source.trim() || new TextEncoder().encode(spec.source).length > 16384) return "填写策略名称与代码，代码不能超过16KiB";
  const start = data.bars.findIndex(b => b.end === spec.start), end = data.bars.findIndex(b => b.end === spec.end);
  if (start < 30 || end <= start) return "区间须预留30根指标预热K线，至少运行2根K线";
  if (![spec.basePosition, spec.tradeSize].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000 && n % 100 === 0) || spec.tradeSize === 0) return "底仓与每笔数量须为100股整手";
  for (const [n, max] of [[spec.cash, 100000000], [spec.commissionBps, 100], [spec.minimumFee, 1000], [spec.slippageBps, 100]]) if (!Number.isFinite(n) || n < 0 || n > max) return "资金或费用超出范围";
  return null;
}
export interface ResearchContext { label: string; text: string }
export function researchContext(label: string, evidence: Record<string, unknown>): ResearchContext {
  return { label, text: `【投行研究上下文】\n以下是当前面板的研究对象与用户草稿，不是已验证结论。分析前请用投行工具读取对应数据；修改策略后请明确实际运行的代码与参数。\n${JSON.stringify(evidence, null, 2)}` };
}
