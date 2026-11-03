import { useEffect, useState } from "react";
import { marginScopes, marginSeries, type MarginScope, type MarginSnapshot } from "./margin-logic";
import { ResearchSelect } from "./ResearchSelect";
import { researchContext, type ResearchContext } from "./code-logic";

const yi = (n: number | null | undefined) => n == null ? "—" : (n / 1e8).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export default function MarginView({ snapshots, selectedId, busy, onSelect, onSync, onContext }: {
  snapshots: MarginSnapshot[]; selectedId: string; busy: boolean; onSelect: (id: string) => void; onSync: () => void; onContext: (context: ResearchContext) => void;
}) {
  const [scope, setScope] = useState<MarginScope>("combined");
  const snapshot = snapshots.find(s => s.id === selectedId) ?? snapshots[0];
  const series = snapshot ? marginSeries(snapshot, scope) : [];
  const latest = series.at(-1), previous = series.at(-2);
  const label = marginScopes.find(([id]) => id === scope)?.[1];
  useEffect(() => onContext(researchContext(`两融观察 / ${label}`, { page: "margin", scope, marginSnapshotId: snapshot?.id, code: scope === "hikvision" ? "002415.SZ" : undefined, lastDate: snapshot?.shanghai.at(-1)?.date })), [scope, snapshot, label, onContext]);
  if (!snapshot || !latest) return <div className="investment-empty"><h1>两融观察</h1><p>沪深市场与海康威视 / 交易所日度数据</p><button className="investment-primary" disabled={busy} onClick={onSync}>同步两融数据</button></div>;
  const delta = previous ? latest.financingBalance - previous.financingBalance : null;
  const low = Math.min(...series.map(p => p.financingBalance)), high = Math.max(...series.map(p => p.financingBalance));
  const line = series.map((p,i) => `${i / Math.max(1,series.length - 1) * 900},${175 - (p.financingBalance-low)/(high-low || 1)*150}`).join(" ");
  return <>
    <div className="investment-page-heading"><div><span className="investment-eyebrow">融资 / 融券 / 杠杆资金</span><h1>两融观察</h1></div><span className="investment-footnote">交易日 {latest.date}</span></div>
    <div className="investment-report-select"><span>数据快照</span><ResearchSelect label="两融快照" value={snapshot.id} onChange={onSelect} options={snapshots.map(s => ({ value:s.id,label:new Date(s.createdAt).toLocaleString(),detail:`${s.shanghai[0]?.date} → ${s.shanghai.at(-1)?.date} / ${s.id.slice(0,8)}` }))} /></div>
    <div className="investment-tabs" aria-label="两融范围">{marginScopes.map(([id,name]) => <button key={id} aria-pressed={scope===id} onClick={()=>setScope(id)}>{name}</button>)}</div>
    <div className="investment-metrics investment-report-metrics"><div>融资余额 / 亿元<strong>{yi(latest.financingBalance)}</strong></div><div>较前一交易日 / 亿元<strong className={delta == null ? "" : delta >= 0 ? "positive" : "negative"}>{delta != null && delta > 0 ? "+" : ""}{yi(delta)}</strong></div><div>融券余额 / 亿元<strong>{yi(latest.shortBalance)}</strong></div><div>两融余额 / 亿元<strong>{yi(latest.totalBalance)}</strong></div></div>
    <section className="investment-section"><div className="investment-section-title"><h2>{label}融资余额</h2><span>{series.length} 个已公布交易日 / 亿元</span></div><div className="investment-between investment-footnote"><span>区间最低 {yi(low)}</span><span>区间最高 {yi(high)}</span></div><svg className="investment-chart" viewBox="0 0 900 200" role="img" aria-label={`${label}融资余额趋势`}><polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" /></svg><div className="investment-between investment-footnote"><span>{series[0].date}</span><span>{latest.date}</span></div></section>
    <section className="investment-section"><div className="investment-section-title"><h2>逐日明细</h2><span>人民币亿元 / 缺失显示 —</span></div><div className="investment-table"><table><thead><tr><th>交易日</th><th>融资余额</th><th>余额变化</th><th>融资买入</th><th>融资偿还</th><th>融券余额</th><th>两融余额</th></tr></thead><tbody>{series.map((p,i) => <tr key={p.date}><td>{p.date}</td><td>{yi(p.financingBalance)}</td><td>{yi(i ? p.financingBalance-series[i-1].financingBalance : null)}</td><td>{yi(p.financingBuy)}</td><td>{yi(p.financingRepay)}</td><td>{yi(p.shortBalance)}</td><td>{yi(p.totalBalance)}</td></tr>).reverse()}</tbody></table></div></section>
    <details><summary>融券数量 / 股或份</summary><div className="investment-table"><table><thead><tr><th>交易日</th><th>融券余量</th><th>融券卖出量</th></tr></thead><tbody>{series.map(p=><tr key={p.date}><td>{p.date}</td><td>{p.shortVolume.toLocaleString("zh-CN",{maximumFractionDigits:0})}</td><td>{p.shortSellVolume.toLocaleString("zh-CN",{maximumFractionDigits:0})}</td></tr>).reverse()}</tbody></table></div></details>
    <details open><summary>来源、精度与使用边界</summary><p className="investment-footnote">{snapshot.source} / 采集于 {new Date(snapshot.createdAt).toLocaleString()}</p><ul>{snapshot.warnings.map(w=><li key={w}>{w}</li>)}</ul><p className="investment-footnote">行情日不等于发布时间；本次两融数据用于观察，尚未注入历史代码策略。</p></details>
  </>;
}
