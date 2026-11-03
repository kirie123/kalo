import { useEffect, useState } from "react";
import type { Report, Snapshot, Spec } from "./types";
import { categories, categoryOf, inCategory, defaultSpec, formatMoney, percent, specError } from "./logic";
import { EquityChart } from "./Charts";
export function BacktestForm({
  snapshot,
  busy,
  onRun,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onRun: (spec: Spec) => void;
}) {
  const draftKey = `kalo.investment.draft.${snapshot.id}`;
  const [spec, setSpec] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
      if (saved?.snapshotId === snapshot.id && !specError(saved, snapshot)) return saved as Spec;
    } catch { /* A damaged draft must not prevent opening the panel. */ }
    return defaultSpec(snapshot);
  });
  useEffect(() => {
    if (!specError(spec, snapshot)) sessionStorage.setItem(draftKey, JSON.stringify(spec));
  }, [draftKey, spec, snapshot]);
  const error = specError(spec, snapshot);
  const codes = spec.codes ?? snapshot.instruments.map(i => i.code);
  const selectCodes = (next: string[]) => setSpec({ ...spec, codes: next, holdings: Math.max(1, Math.min(spec.holdings, next.length)) });
  const field = (
    key: keyof Spec,
    label: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(spec[key])}
        onChange={(e) => setSpec({ ...spec, [key]: e.target.valueAsNumber })}
      />
    </label>
  );
  return (
    <section className="investment-section">
      <h2>定义实验</h2>
      <div className="investment-controls"><span className="investment-badge">ETF 动量轮动</span><span className="investment-badge">次日开盘成交</span><span className="investment-badge">只做多</span></div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) onRun(spec);
        }}
      >
        <fieldset className="investment-pool">
          <legend>回测标的 <span>已选 {codes.length} / {snapshot.instruments.length} 只</span></legend>
          <div className="investment-controls">{categories.map(category => <button type="button" key={category} onClick={() => selectCodes(inCategory(snapshot.instruments, category).map(i => i.code))}>{category}</button>)}</div>
          <div className="investment-pool-options">{snapshot.instruments.map(i => <label key={i.code}>
            <input type="checkbox" checked={codes.includes(i.code)} onChange={e => selectCodes(e.target.checked ? [...codes, i.code] : codes.filter(code => code !== i.code))} />
            <span>{i.name}<small>{i.code} / {categoryOf(i)}</small></span>
          </label>)}</div>
          <p>基准固定为沪深300 ETF；只在勾选的标的中轮动。</p>
        </fieldset>
        <div className="investment-form">
          <label>
            策略
            <select
              value={spec.flowFilter ? "flow" : "price"}
              onChange={(e) =>
                setSpec({ ...spec, flowFilter: e.target.value === "flow" })
              }
            >
              <option value="price">价格动量轮动</option>
              <option value="flow">动量 + 5 日净申购过滤</option>
            </select>
          </label>
          {field("capital", "初始资金 / 元", 1000, 100000000, 1000)}
          <label>
            开始日期
            <input
              type="date"
              value={spec.start}
              onChange={(e) => setSpec({ ...spec, start: e.target.value })}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={spec.end}
              onChange={(e) => setSpec({ ...spec, end: e.target.value })}
            />
          </label>
          {field("lookback", "动量窗口 / 交易日", 2, 120)}
          {field("rebalance", "调仓间隔 / 交易日", 1, 60)}
          {field("holdings", "持仓数量", 1, codes.length)}
        </div>
        <details className="investment-costs"><summary>交易成本与撮合假设</summary><div className="investment-form">
          {field("commissionBps", "双向佣金 / bp", 0, 100, 0.1)}
          {field("minimumFee", "单笔最低佣金 / 元", 0, 1000, 1)}
          {field("slippageBps", "单边滑点 / bp", 0, 100, 0.1)}
        </div><p>仅持有正动量标的，空缺留现金。成交不超过前日成交量 1%，期末按收盘估值。</p></details>
        {spec.flowFilter && (
          <div className="investment-warning">
            资金过滤要求决策前实际已采集到的完整数据。刚下载的历史份额不能用于此前的决策，数据不足将阻止运行。
          </div>
        )}
        {error && (
          <p role="alert" className="investment-error">
            {error}
          </p>
        )}
        <button className="investment-primary" disabled={busy || !!error}>
          运行回测
        </button>
      </form>
    </section>
  );
}
export function ReportView({ report }: { report: Report }) {
  const [tab, setTab] = useState("overview");
  const benchmarkReturn = report.equity.at(-1)?.benchmark == null ? null : report.equity.at(-1)!.benchmark / report.spec.capital - 1;
  return (
    <section className="investment-section">
      <div className="investment-between">
        <h2>实验报告</h2>
        <span>{new Date(report.createdAt).toLocaleString()}</span>
      </div>
      <p>
        {report.spec.start} → {report.spec.end} /{" "}
        {report.spec.flowFilter ? "资金过滤" : "价格动量"} / 引擎版本{" "}
        {report.engineVersion}
      </p>
      <p>回测标的：{report.spec.codes?.join("、") ?? "该历史快照的全部标的"}</p>
      <div className="investment-tabs">
        {[
          ["overview", "收益与风险"],
          ["trades", "成交与拒单"],
          ["evidence", "数据与假设"],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <>
          <div className="investment-metrics investment-report-metrics">
            <div>
              区间收益<strong>{percent(report.totalReturn)}</strong>
            </div>
            <div>
              最大回撤<strong>{percent(report.maxDrawdown)}</strong>
            </div>
            <div>
              基准收益<strong>{benchmarkReturn == null ? "—" : percent(benchmarkReturn)}</strong>
            </div>
            <div>超额收益<strong>{benchmarkReturn == null ? "—" : percent(report.totalReturn - benchmarkReturn)}</strong></div>
          </div>
          <EquityChart report={report} />
          <p className="investment-controls">
            <span>佣金 ¥ {formatMoney(report.fees)}</span><span>滑点已计入成交价</span>
          </p>
          <p>
            期末现金 ¥ {formatMoney(report.equity.at(-1)?.cash)} /{" "}
            {report.trades.filter((t) => t.quantity > 0).length} 笔成交 /{" "}
            {report.trades.filter((t) => !t.quantity).length} 笔未成交
          </p>
          <details>
            <summary>逐日资产与回撤</summary>
            <div className="investment-table">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>资产 / 元</th>
                    <th>现金 / 元</th>
                    <th>回撤</th>
                  </tr>
                </thead>
                <tbody>
                  {report.equity.map((p) => (
                    <tr key={p.date}>
                      <td>{p.date}</td>
                      <td>{formatMoney(p.equity)}</td>
                      <td>{formatMoney(p.cash)}</td>
                      <td>{percent(p.drawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {tab === "trades" && (
        <div className="investment-table">
          <table>
            <thead>
              <tr>
                <th>日期 / 标的</th>
                <th>方向 / 份数</th>
                <th>成交价</th>
                <th>佣金</th>
                <th>现金余额</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {report.trades.map((t, i) => (
                <tr key={i}>
                  <td>
                    {t.date}
                    <br />
                    {t.code}
                  </td>
                  <td>
                    {t.side} {t.quantity}
                  </td>
                  <td>{t.quantity ? t.price.toFixed(4) : "—"}</td>
                  <td>{formatMoney(t.fee)}</td>
                  <td>{formatMoney(t.cashAfter)}</td>
                  <td>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!report.trades.length && (
            <p>本区间没有符合条件的交易，资产保留现金。</p>
          )}
        </div>
      )}
      {tab === "evidence" && (
        <>
          <dl>
            <dt>快照 ID</dt>
            <dd>{report.spec.snapshotId}</dd>
            <dt>规范化数据 SHA-256</dt>
            <dd>{report.snapshotHash}</dd>
            <dt>内核源码 SHA-256</dt>
            <dd>{report.engineHash || "旧报告未记录"}</dd>
            <dt>实验 ID</dt>
            <dd>{report.id}</dd>
            <dt>参数</dt>
            <dd>
              资金 {formatMoney(report.spec.capital)} 元；动量{" "}
              {report.spec.lookback} 日；每 {report.spec.rebalance} 日调仓；持仓{" "}
              {report.spec.holdings} 只；佣金 {report.spec.commissionBps}bp /
              最低 {report.spec.minimumFee} 元；滑点 {report.spec.slippageBps}bp
            </dd>
          </dl>
          <ul>
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p>
            稳健性验证尚未自动执行。可更改窗口、调仓间隔和成本重新运行，历史报告不会被覆盖。
          </p>
        </>
      )}
    </section>
  );
}
