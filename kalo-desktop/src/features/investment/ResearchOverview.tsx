import AppIcon from "../../components/AppIcon";
import { useState } from "react";
import { PoolFilter } from "./PoolFilter";
import { EquityChart, Sparkline } from "./Charts";
import { flowWindow, formatMoney, percent, inCategory, categoryOf } from "./logic";
import type { Report, Snapshot } from "./types";

export function DataSources({ snapshot }: { snapshot?: Snapshot }) {
  const instruments = snapshot?.instruments ?? [];
  const prices = instruments.reduce((n, i) => n + i.bars.length, 0);
  const shares = (market: string) => instruments.filter(i => i.code.endsWith(market)).reduce((n, i) => n + i.funds.filter(f => f.shares != null).length, 0);
  const navs = instruments.reduce((n, i) => n + i.funds.filter(f => f.nav != null).length, 0);
  return <div className="investment-sources">
    {[["腾讯行情", "日线 / 前复权", prices], ["上海证券交易所", "沪市 ETF 基金份额", shares(".SH")], ["深圳证券交易所", "深市 ETF 基金份额", shares(".SZ")], ["东方财富", "基金单位净值", navs]].map(([name, type, count]) =>
      <div className="investment-source" key={name}>
        <AppIcon name="plug" size={18} />
        <div><strong>{name}</strong><small>{type}</small></div>
        <span className={`investment-badge ${count ? "is-ready" : ""}`}>{count ? `${count} 条` : snapshot ? "暂无覆盖" : "待同步"}</span>
      </div>)}
  </div>;
}

export function ResearchEmpty({ busy, onSync, onAssistant }: { busy: boolean; onSync: () => void; onAssistant: () => void }) {
  return <>
    <div className="investment-page-heading"><div><span className="investment-eyebrow">A 股 / 场内 ETF</span><h1>建立研究数据集</h1></div><span className="investment-badge">尚未同步</span></div>
    <section className="investment-empty">
      <AppIcon name="chart" size={32} />
      <h2>连接数据，开始研究</h2>
      <p>15 只 ETF / 宽基 / 双创 / 行业主题</p>
      <p>创业板、创业板50、双创50、科创50，以及半导体、军工、银行、证券、医疗、医药、酒、新能源车</p>
      <div className="investment-controls"><button className="investment-primary" disabled={busy} onClick={onSync}>{busy ? "同步中…" : "同步免费数据"}</button><button onClick={onAssistant}>交给研究助手</button></div>
    </section>
    <div className="investment-section-title"><h2>数据源</h2><span>无需数据账号</span></div>
    <DataSources />
    <div className="investment-empty-workflow"><span>01　行情与份额</span><span>02　资金分析</span><span>03　策略回测</span><span>04　实验报告</span></div>
  </>;
}

export default function ResearchOverview({ snapshot, report, reportCount, onSelect, onPage }: {
  snapshot: Snapshot; report?: Report; reportCount: number; onSelect: (code: string) => void; onPage: (page: string) => void;
}) {
  const [category, setCategory] = useState("全部");
  const instruments = inCategory(snapshot.instruments, category);
  const complete = instruments.filter(i => flowWindow(i, 5).total != null).length;
  return <>
    <div className="investment-page-heading"><div><span className="investment-eyebrow">A 股 / 场内 ETF</span><h1>研究概览</h1></div><span className="investment-badge">日线研究</span></div>
    <div className="investment-metrics">
      <div>{category === "全部" ? "研究池" : category}<strong>{instruments.length}<small>只 ETF</small></strong></div>
      <div>5 日资金覆盖<strong>{complete}<small>/ {instruments.length} 只</small></strong></div>
      <div>已保存实验<strong>{reportCount}<small>份报告</small></strong></div>
    </div>
    <div className="investment-section-title"><h2>研究池</h2><button onClick={() => onPage("flows")}>查看资金 →</button></div>
    <PoolFilter instruments={snapshot.instruments} value={category} onChange={setCategory} />
    {!instruments.length && <p>当前快照没有此类 ETF，请同步最新数据。</p>}
    <div className="investment-table"><table><thead><tr><th>标的</th><th className="number">最新收盘</th><th className="number">日涨跌</th><th>60 日走势</th><th className="number">5 日净申购 / 亿</th></tr></thead><tbody>
      {instruments.map(i => {
        const last = i.bars.at(-1), previous = i.bars.at(-2);
        const change = last && previous ? last.close / previous.close - 1 : null;
        const flow = flowWindow(i, 5);
        return <tr key={i.code}>
          <td><button className="investment-link" onClick={() => onSelect(i.code)}>{i.name}<small>{i.code} / {categoryOf(i)}</small></button></td>
          <td className="number">{last?.close.toFixed(3) ?? "—"}</td>
          <td className={`number ${change != null && change >= 0 ? "investment-up" : "investment-down"}`}>{change == null ? "—" : `${change > 0 ? "+" : ""}${percent(change)}`}</td>
          <td><Sparkline values={i.bars.slice(-60).map(b => b.close)} /></td>
          <td className="number">{flow.total == null ? <span className="investment-badge">{flow.count}/5 日</span> : formatMoney(flow.total / 1e8)}</td>
        </tr>;
      })}
    </tbody></table></div>
    <div className="investment-overview-bottom">
      <section><div className="investment-section-title"><h2>最近实验</h2><button onClick={() => onPage("backtest")}>{report ? "查看报告" : "新建实验"} →</button></div>
        {report ? <><div className="investment-inline-metrics"><span>区间收益<strong>{percent(report.totalReturn)}</strong></span><span>最大回撤<strong>{percent(report.maxDrawdown)}</strong></span></div><EquityChart report={report} /></> : <div className="investment-placeholder"><AppIcon name="checklist" size={24} /><p>尚无实验报告</p><button onClick={() => onPage("backtest")}>配置价格动量策略</button></div>}
      </section>
      <section><div className="investment-section-title"><h2>数据状态</h2><button onClick={() => onPage("data")}>查看 →</button></div><DataSources snapshot={snapshot} /><p className="investment-footnote">{snapshot.warnings.length ? `${snapshot.warnings.length} 项数据提醒` : "本次采集无接口告警"}</p></section>
    </div>
  </>;
}
