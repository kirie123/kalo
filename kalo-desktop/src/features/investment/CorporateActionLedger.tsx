import { useState } from "react";
import type { ScriptReport } from "./code-types";
import { formatMoney } from "./logic";

export default function CorporateActionLedger({ report }: { report: ScriptReport }) {
  const [account, setAccount] = useState("strategy");
  const rows = report.actionLedger?.filter(row => row.account === account) ?? [];
  const final = report.equity.at(-1);
  if (!report.accounting) return null;
  return <details className="investment-action-ledger">
    <summary>分红与送转账务 · 税前股息</summary>
    <p className="investment-footnote">按登记日收盘持仓享权；现金到账前不可使用，送转上市前不可卖出。收益已含税前股息，未计个人差别化红利所得税。</p>
    <p>策略股息收入 ¥ {formatMoney(final?.dividendIncome ?? 0)} · 待到账 ¥ {formatMoney(final?.dividendReceivable ?? 0)} · 待上市 {final?.pendingShares ?? 0} 股</p>
    <p>期末每股平均成本 ¥ {formatMoney(final?.averageCost ?? 0)} · 已实现交易盈亏 ¥ {formatMoney(final?.realizedPnl ?? 0)}（股息另计）</p>
    <div className="investment-tabs" aria-label="公司行为账户">{[["strategy", "策略账户"], ["benchmark", "持有基准"]].map(([id, label]) => <button key={id} aria-pressed={account === id} onClick={() => setAccount(id)}>{label}</button>)}</div>
    {!rows.length ? <p>本区间没有已登记的分派权益。</p> : <div className="investment-table"><table>
      <thead><tr><th>日期 / 事件</th><th>登记持仓</th><th>现金变动</th><th>送转处理数量</th><th>应收 / 待上市</th><th>持仓 / 可卖</th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={`${row.actionId}-${row.stage}-${i}`}><td>{row.date}<small>{row.stage}</small></td><td>{row.eligibleShares} 股</td><td>¥ {formatMoney(row.cashDelta)}</td><td>{row.shareDelta} 股</td><td>¥ {formatMoney(row.receivable)} / {row.pendingShares} 股</td><td>{row.position} / {row.sellable}</td></tr>)}</tbody>
    </table></div>}
    {rows.some(row => row.shareDelta > 0) && <p className="investment-footnote">同一份送转股份分别经历确权与上市，处理数量不能跨步骤相加；以上市后的持仓与可卖数量为准。</p>}
    <details><summary>已核实分派条款</summary><div className="investment-table"><table><thead><tr><th>登记 / 除权</th><th>每股现金 / 送 / 转</th><th>现金到账 / 股份上市</th></tr></thead><tbody>{report.corporateActions?.map(a => <tr key={a.id}><td>{a.recordDate}<small>{a.exDate}</small></td><td>{a.cashPerShare} 元 / {a.bonusPerShare} / {a.transferPerShare}</td><td>{a.payDate ?? "—"}<small>{a.listingDate ?? "—"}</small></td></tr>)}</tbody></table></div></details>
  </details>;
}
