import { useState } from "react";
import type { ScriptReport as Report } from "./code-types";
import { formatMoney, percent } from "./logic";

export default function ScriptReportView({ report }: { report: Report }) {
  const [tab, setTab] = useState("result");
  const points = report.equity;
  const [accountPage, setAccountPage] = useState(0);
  const [orderPage, setOrderPage] = useState(0);
  const pager = (n: number, page: number, set: (p: number) => void) => <div className="investment-pagination"><span>{n} 条 / 第 {page + 1} 页，共 {Math.max(1, Math.ceil(n / 100))} 页</span><button disabled={page === 0} onClick={() => set(page-1)}>上一页</button><button disabled={(page+1)*100 >= n} onClick={() => set(page+1)}>下一页</button></div>;
  const values = points.flatMap(p => [p.equity, p.benchmark]);
  const low = Math.min(...values), high = Math.max(...values);
  const line = (key: "equity" | "benchmark") => points.map((p, i) => `${i / Math.max(1, points.length - 1) * 900},${180 - (p[key] - low) / (high - low || 1) * 160}`).join(" ");
  const final = points.at(-1);
  const filled = report.orders.filter(o => o.quantity > 0).length;
  return <section className="investment-section">
    <div className="investment-section-title"><h2>{report.spec.title}</h2><span>{new Date(report.createdAt).toLocaleString()}</span></div>
    <p className="investment-footnote">{report.security.name} / {report.spec.start.slice(0, 16)} → {report.spec.end.slice(0, 16)} / {report.timeframe ?? "5m"}</p>
    <div className="investment-tabs" aria-label="代码报告内容">{[["result", "收益与底仓"], ["orders", "信号与成交"], ["evidence", "代码与证据"]].map(([id, name]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{name}</button>)}</div>
    {tab === "result" && <>
      <div className="investment-metrics investment-report-metrics">
        <div>相对持有增益<strong>{formatMoney(report.excessPnl)}<small>元</small></strong></div>
        <div>组合收益<strong>{percent(report.totalReturn)}</strong></div>
        <div>持有基准<strong>{percent(report.benchmarkReturn)}</strong></div>
        <div>最大回撤<strong>{percent(report.maxDrawdown)}</strong></div>
      </div>
      <div className="investment-chart-legend"><i />代码策略 <i className="benchmark" />同等底仓持有</div>
      <svg className="investment-chart" viewBox="0 0 900 200" role="img" aria-label="代码策略与底仓持有资产曲线"><polyline points={line("equity")} fill="none" stroke="var(--text)" strokeWidth="2" /><polyline points={line("benchmark")} fill="none" stroke="var(--tone-blue)" strokeWidth="1.5" /></svg>
      <div className="investment-between"><span>初始资产 ¥ {formatMoney(report.initialEquity)}</span><span>{filled} 笔成交 / {report.orders.length - filled} 笔拒单</span><span>显式费用 ¥ {formatMoney(report.costs)}</span></div>
      <p>期末现金 ¥ {formatMoney(final?.cash ?? 0)} / 持仓 {final?.position ?? 0} 股 / 可卖 {final?.sellable ?? 0} 股</p>
      <details><summary>KDJ 与逐根账户</summary><div className="investment-table"><table><thead><tr><th>时间</th><th>K / D / J</th><th>资产</th><th>持仓 / 可卖</th></tr></thead><tbody>{points.slice(accountPage*100,(accountPage+1)*100).map(p => <tr key={p.time}><td>{p.time.slice(0, 16).replace("T", " ")}</td><td>{p.k.toFixed(2)} / {p.d.toFixed(2)} / {p.j.toFixed(2)}</td><td>{formatMoney(p.equity)}</td><td>{p.position} / {p.sellable}</td></tr>)}</tbody></table></div>{pager(points.length,accountPage,setAccountPage)}</details>
    </>}
    {tab === "orders" && <>{pager(report.orders.length,orderPage,setOrderPage)}<div className="investment-table"><table><thead><tr><th>信号收盘 → 实际成交</th><th>方向 / 请求 / 成交</th><th>价格</th><th>佣金 / 印花税 / 过户费</th><th>持仓 / 可卖</th><th>原因</th></tr></thead><tbody>{report.orders.slice(orderPage*100,(orderPage+1)*100).map((o, i) => <tr key={i}><td>{o.signalAt.slice(0, 16).replace("T", " ")}<small>{o.executedAt?.slice(0, 16).replace("T", " ") ?? "未成交"}</small></td><td>{o.side === "buy" ? "买入" : "卖出"} / {o.requested} / {o.quantity}</td><td>{o.quantity ? o.price.toFixed(report.security.tickSize < .01 ? 3 : 2) : "—"}</td><td>{o.commission.toFixed(2)} / {o.stampTax.toFixed(2)} / {o.transferFee.toFixed(2)}</td><td>{o.positionAfter} / {o.sellableAfter}</td><td>{o.reason}</td></tr>)}</tbody></table>{!report.orders.length && <p>代码未产生买卖信号，保持现金与初始底仓。</p>}</div></>}
    {tab === "evidence" && <><dl><dt>数据集</dt><dd>{report.spec.datasetId}</dd><dt>数据 SHA-256</dt><dd>{report.datasetHash}</dd><dt>引擎 SHA-256</dt><dd>{report.engineHash}</dd><dt>实验 ID</dt><dd>{report.id}</dd></dl><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul><pre className="investment-code-evidence">{report.spec.source}</pre></>}
  </section>;
}
