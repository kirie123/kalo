import { useEffect, useState } from "react";
import type { Dataset, ScriptSpec } from "./code-types";
import type { ExperimentDraft } from "./experiment-drafts";
import { codeError, researchContext, type ResearchContext } from "./code-logic";
import AppIcon from "../../components/AppIcon";

export default function ExperimentEditor({ draft, data, busy, saveError, onChange, onRun, onContext, onAsk, onRecords }: {
  draft: ExperimentDraft; data: Dataset; busy: boolean; saveError: string;
  onChange: (spec: ScriptSpec) => void; onRun: (spec: ScriptSpec) => void;
  onContext: (context: ResearchContext) => void; onAsk: () => void; onRecords: () => void;
}) {
  const spec = draft.spec;
  const [scrollTop, setScrollTop] = useState(0);
  const [copyError, setCopyError] = useState("");
  useEffect(() => {
    onContext(researchContext(`${data.security.name} / 编辑策略`, { page: "code", mode: "edit", draftId: draft.id, datasetId: data.id, security: data.security, timeframe: data.timeframe, coverage: { start: data.sessions[0], end: data.sessions.at(-1), tradingDays: data.sessions.length, bars: data.bars.length, blockedSessions: data.blockedSessions ?? [] }, draft: spec }));
  }, [data, draft.id, spec, onContext]);
  const error = codeError(spec, data);
  const number = (key: "cash" | "basePosition" | "tradeSize" | "commissionBps" | "minimumFee" | "slippageBps", label: string, step: number) => <label>{label}<input type="number" min={0} step={step} value={spec[key]} onChange={e => onChange({ ...spec, [key]: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0 })} /></label>;
  return <section className="experiment-editor">
    <div className="experiment-toolbar"><span className="experiment-state">{saveError ? "草稿未保存" : "草稿已保存在本机"}</span><div className="investment-controls"><button onClick={onRecords}>实验记录</button><button className="investment-primary" disabled={busy || !!error} onClick={() => onRun({ ...spec })}>{busy ? "任务处理中…" : "运行回测"}</button></div></div>
    <label className="experiment-name">实验名称<input aria-label="策略名称" value={spec.title} maxLength={100} onChange={e => onChange({ ...spec, title: e.target.value })} /></label>
    <p className="experiment-data-summary">{data.security.name} <span>{data.security.code} / {data.timeframe} / T+{data.security.settlementDays}</span></p>
    <div className="investment-code-toolbar"><span>strategy.rhai</span><button onClick={onAsk}><AppIcon name="sparkles" size={14} />让助手修改</button><button onClick={() => { void navigator.clipboard.writeText(spec.source).then(() => setCopyError("")).catch(() => setCopyError("复制失败，请在编辑器中选择代码复制")); }}>复制代码</button></div>
    <div className="investment-code-editor"><pre aria-hidden="true"><span style={{ transform: `translateY(-${scrollTop}px)` }}>{spec.source.split("\n").map((_, i) => i + 1).join("\n")}</span></pre><textarea aria-label="策略代码" spellCheck={false} wrap="off" value={spec.source} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} onChange={e => onChange({ ...spec, source: e.target.value })} /></div>
    {(error || copyError) && <p className="investment-warning" role="alert">{error || copyError}</p>}
    <details className="experiment-settings"><summary><span>回测设置</span><span>{spec.start.slice(0, 10)} — {spec.end.slice(0, 10)}</span></summary>
      <div className="investment-form"><label>开始时刻<input aria-label="代码回测开始" type="datetime-local" step={300} value={spec.start.slice(0,16)} min={data.bars[30]?.end.slice(0,16)} max={data.bars.at(-2)?.end.slice(0,16)} onChange={e => onChange({...spec,start:`${e.target.value}:00+08:00`})} /></label><label>结束时刻<input aria-label="代码回测结束" type="datetime-local" step={300} value={spec.end.slice(0,16)} min={data.bars[31]?.end.slice(0,16)} max={data.bars.at(-1)?.end.slice(0,16)} onChange={e => onChange({...spec,end:`${e.target.value}:00+08:00`})} /></label>{number("cash", "初始现金 / 元", 1000)}{number("basePosition", "已有可卖底仓 / 股份", data.security.lotSize)}{number("tradeSize", "每笔数量 / 股份", data.security.lotSize)}</div>
      <div className="investment-form">{number("commissionBps", "佣金 / bp", 0.1)}{number("minimumFee", "最低佣金 / 元", 1)}{number("slippageBps", "单边滑点 / bp", 0.1)}</div>
      <p className="investment-footnote">{data.security.assetType === "etf" ? "ETF不计股票印花税与过户费。" : "卖出印花税0.05%，双边过户费0.001%。"}初始现金加底仓市值为回测起始资产。</p>
      <details><summary>数据质量与覆盖边界</summary><p>{data.sessions[0]} — {data.sessions.at(-1)} / {data.sessions.length} 个交易日 / {data.bars.length} 根 K 线 / 原始价格</p><ul>{data.warnings.map(w => <li key={w}>{w}</li>)}</ul><p>{data.source}</p>{!!data.blockedSessions?.length && <p>公司行为隔离日期：{data.blockedSessions.join("、")}。回测和预热不可跨越这些日期。</p>}</details>
    </details>
    <details className="experiment-api"><summary>策略 API</summary><p>ctx.history 为截至当前收盘的最多120根原始OHLCV；ctx.kdj / previousKdj 为KDJ(9,3,3)。账户字段：cash、position、sellable、basePosition、tradeSize。用 ctx.state 保存自己的状态。</p><pre className="investment-code-evidence">{'fn on_bar(ctx) {\n    #{ side: "hold", quantity: 0, state: ctx.state }\n}'}</pre><p>返回 buy / sell / hold 与整数股数。订单在下一根开盘尝试成交；import、文件、网络和系统时间不可用。</p></details>
  </section>;
}
