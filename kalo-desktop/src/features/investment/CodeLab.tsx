import { useEffect, useRef, useState } from "react";
import type { Dataset, ScriptReport, ScriptSpec } from "./code-types";
import { codeDefaults, codeError, researchContext, type ResearchContext } from "./code-logic";
import { ResearchSelect } from "./ResearchSelect";
import ScriptReportView from "./ScriptReport";

export default function CodeLab({ datasets, reports, datasetId, reportId, example, busy, onDataset, onReport, onSync, onRun, onContext, onAsk }: {
  datasets: Dataset[]; reports: ScriptReport[]; datasetId: string; reportId: string; example: string; busy: boolean;
  onDataset: (id: string) => void; onReport: (id: string) => void; onSync: () => void; onRun: (spec: ScriptSpec) => void;
  onContext: (context: ResearchContext) => void; onAsk: () => void;
}) {
  const data = datasets.find(d => d.id === datasetId) ?? datasets[0];
  const report = reports.find(r => r.id === reportId) ?? reports[0];
  const reportRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (reportId) reportRef.current?.scrollIntoView({ block: "start" }); }, [reportId]);
  return <>
    <div className="investment-page-heading"><div><span className="investment-eyebrow">自定义信号 / Rust 回测</span><h1>代码策略</h1></div><button onClick={onAsk}>带上下文讨论</button></div>
    <div className="investment-code-data"><div><strong>海康威视 <span>002415.SZ</span></strong><small>5 分钟 / A 股 T+1 / 100 股整手</small></div><button disabled={busy} onClick={onSync}>{busy ? "任务处理中" : "同步分钟数据"}</button></div>
    {data ? <>
      <div className="investment-report-select"><span>冻结数据集</span><ResearchSelect label="分钟数据集" value={data.id} onChange={onDataset} options={datasets.map(d => ({ value: d.id, label: `${d.sessions[0]} → ${d.sessions.at(-1)} / ${d.bars.length} 根`, detail: `${new Date(d.createdAt).toLocaleString()} / ${d.id.slice(0, 8)}` }))} /></div>
      <p className="investment-footnote">{data.sessions.length} 个完整交易日 / {data.bars.length} 根已结束 K 线 / 原始价格</p>
      <details><summary>数据质量与覆盖边界</summary><ul>{data.warnings.map(w => <li key={w}>{w}</li>)}</ul><p>{data.source}</p></details>
      <CodeDraft key={data.id} data={data} example={example} report={report} busy={busy} onRun={onRun} onContext={onContext} onAsk={onAsk} />
    </> : <div className="investment-empty"><h2>先建立分钟数据集</h2><p>同步海康威视近期分钟行情，并核对交易日、缺口和除权除息。</p><button className="investment-primary" disabled={busy} onClick={onSync}>同步并开始写策略</button></div>}
    {report && <div ref={reportRef}><div className="investment-report-select"><span>代码实验</span><ResearchSelect label="代码历史报告" value={report.id} onChange={onReport} options={reports.map(r => ({ value: r.id, label: r.spec.title, detail: `${new Date(r.createdAt).toLocaleString()} / ${r.id.slice(0, 8)}` }))} /></div>{data && report.spec.datasetId !== data.id && <p className="investment-warning">此报告使用另一份冻结数据集。编辑区保留当前草稿，复制报告代码后会使用当前数据与区间重新运行。</p>}<ScriptReportView key={report.id} report={report} /></div>}
  </>;
}

function CodeDraft({ data, example, report, busy, onRun, onContext, onAsk }: {
  data: Dataset; example: string; report?: ScriptReport; busy: boolean; onRun: (spec: ScriptSpec) => void; onContext: (context: ResearchContext) => void; onAsk: () => void;
}) {
  const key = `kalo.investment.code.${data.id}`;
  const [spec, setSpec] = useState<ScriptSpec>(() => {
    try { const saved = JSON.parse(localStorage.getItem(key) ?? "null"); if (saved?.datasetId === data.id && typeof saved.source === "string") return { ...codeDefaults(data, example), ...saved }; } catch { /* Invalid local draft: load the template. */ }
    return codeDefaults(data, example);
  });
  const [saveError, setSaveError] = useState("");
  const [expanded, setExpanded] = useState(!report);
  const [scrollTop, setScrollTop] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(spec)); setSaveError(""); } catch { setSaveError("本地草稿保存失败，请复制代码后再离开"); }
    onContext(researchContext(`${data.security.name} / 代码策略`, { page: "代码策略", datasetId: data.id, security: data.security, timeframe: data.timeframe, coverage: data.sessions, draft: spec, report: report ? { id: report.id, spec: report.spec, excessPnl: report.excessPnl, costs: report.costs } : undefined }));
  }, [data, key, spec, onContext, report]);
  const error = codeError(spec, data);
  const number = (key: "cash" | "basePosition" | "tradeSize" | "commissionBps" | "minimumFee" | "slippageBps", label: string, step: number) => <label>{label}<input type="number" min={0} step={step} value={spec[key]} onChange={e => setSpec({ ...spec, [key]: e.target.valueAsNumber })} /></label>;
  return <details className="investment-code-config" open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary>策略代码与账户 <span>{saveError || "草稿自动保存在本机"}</span></summary>
    <div className="investment-between"><label className="investment-code-title">策略名称<input value={spec.title} maxLength={100} onChange={e => setSpec({ ...spec, title: e.target.value })} /></label><button onClick={onAsk}>让助手修改此策略</button></div>
    <div className="investment-code-toolbar"><span>strategy.rhai</span><span>on_bar(ctx) → 订单意图</span><button type="button" onClick={() => { navigator.clipboard.writeText(spec.source).catch(() => setSaveError("复制失败，请在编辑器中选择代码复制")); }}>复制代码</button></div>
    <div className="investment-code-editor"><pre aria-hidden="true"><span style={{ transform: `translateY(-${scrollTop}px)` }}>{spec.source.split("\n").map((_, i) => i + 1).join("\n")}</span></pre><textarea ref={editor} aria-label="策略代码" spellCheck={false} wrap="off" value={spec.source} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} onChange={e => setSpec({ ...spec, source: e.target.value })} /></div>
    <div className="investment-controls">{report && <button type="button" onClick={() => { onContext(researchContext("恢复报告代码", { reportId: report.id })); setSpec({ ...report.spec, datasetId: data.id, start: spec.start, end: spec.end }); }}>复制报告代码到草稿</button>}<span className="investment-footnote">代码可修改信号、数量与状态；执行仍遵守 T+1、现金与交易费用。</span></div>
    <details><summary>策略 API 与示例用法</summary><p>ctx.history 为截至当前收盘的最多120根原始OHLCV；ctx.kdj / previousKdj 为KDJ(9,3,3)。账户字段：cash、position、sellable、basePosition、tradeSize。用 ctx.state 保存自己的状态。</p><pre className="investment-code-evidence">{'fn on_bar(ctx) {\n    #{ side: "hold", quantity: 0, state: ctx.state }\n}'}</pre><p>返回 buy / sell / hold 与整数股数。订单在下一根开盘尝试成交；import、文件、网络和系统时间不可用。</p></details>
    <div className="investment-form"><label>开始时刻<ResearchSelect label="代码回测开始" value={spec.start} onChange={start => setSpec({ ...spec, start })} options={data.bars.slice(30, -1).map(b => ({ value: b.end, label: b.end.slice(0, 16).replace("T", " ") }))} /></label><label>结束时刻<ResearchSelect label="代码回测结束" value={spec.end} onChange={end => setSpec({ ...spec, end })} options={data.bars.slice(31).map(b => ({ value: b.end, label: b.end.slice(0, 16).replace("T", " ") }))} /></label>{number("cash", "初始现金 / 元", 1000)}{number("basePosition", "已有可卖底仓 / 股", 100)}{number("tradeSize", "每笔数量 / 股", 100)}</div>
    <details><summary>费用设置</summary><div className="investment-form">{number("commissionBps", "佣金 / bp", 0.1)}{number("minimumFee", "最低佣金 / 元", 1)}{number("slippageBps", "单边滑点 / bp", 0.1)}</div><p>卖出印花税0.05%，双边过户费0.001%。初始现金加底仓市值为回测起始资产。</p></details>
    {(error || saveError) && <p className="investment-warning" role="alert">{error || saveError}</p>}
    <button className="investment-primary" disabled={busy || !!error} onClick={() => { onRun(spec); setExpanded(false); }}>运行代码回测</button>
  </details>;
}
