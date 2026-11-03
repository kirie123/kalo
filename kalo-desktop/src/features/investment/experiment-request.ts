export const strategyIdeaKey = "kalo.investment.strategy-idea.v1";
export const strategyIdeaLimit = 6000;
export const strategyIdeaExample = "选一只创业板 ETF，用 15 分钟 KDJ 做底仓做 T。已有 1000 份、现金 10 万元，每次 100 份。帮我选数据、写代码并回测，和一直持有比较。";

export function acceptsStrategyExample(value: string, event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }, compositionGuard: boolean): boolean {
  return value === "" && event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229 && !compositionGuard;
}

export function strategyIdeaError(idea: string): string | null {
  if (!idea.trim()) return "请先描述你想研究的策略";
  if (idea.length > strategyIdeaLimit) return `策略描述请控制在 ${strategyIdeaLimit} 字以内`;
  return null;
}

export function strategyExperimentPrompt(idea: string): string {
  const error = strategyIdeaError(idea);
  if (error) throw new Error(error);
  return `${idea.trim()}\n\n【新建策略实验】\n请把上面的想法落成可运行的实验：用投行工具查询真实数据目录与策略运行时，选择或同步合适的数据，编写策略并实际运行回测，让报告和曲线直接出现在投行面板。不要只给建议、代码或文字报告。\n这是独立的新实验，不继承之前会话或面板的证券、策略与参数。严格保留我明确的条件；普通缺省参数可采用工具默认值并说明，影响策略含义的关键歧义才询问。依据真实覆盖选择区间，不伪造历史；不可支持的条件应说明。代码策略使用分钟数据与代码回测工具，明确的ETF轮动可使用轮动工具。结束时说明实际参数、数据覆盖、报告ID、相对基准表现及限制；失败时说明原因并保留原意修复。`;
}
