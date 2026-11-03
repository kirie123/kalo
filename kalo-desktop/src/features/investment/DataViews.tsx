import { useState } from "react";
import type { Instrument, Snapshot } from "./types";
import { rankedFlows, formatMoney } from "./logic";
import { Candles } from "./Charts";
import { DataSources } from "./ResearchOverview";
export function FlowView({
  snapshot,
  onSelect,
  initialDays = 5,
}: {
  snapshot: Snapshot;
  onSelect: (code: string) => void;
  initialDays?: number;
}) {
  const [days, setDays] = useState(initialDays);
  const rows = rankedFlows(snapshot, days);
  const complete = rows.filter(r => r.flow.total != null);
  const total = complete.reduce((sum, r) => sum + (r.flow.total ?? 0), 0);
  const maximum = Math.max(1, ...complete.map(r => Math.abs(r.flow.total!)));
  return (
    <>
      <div className="investment-between">
        <div>
          <h1>ETF 资金观察</h1>
          <span className="investment-eyebrow">净申购估算 / 人民币</span>
        </div>
        <select
          aria-label="资金窗口"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={1}>1 交易日</option>
          <option value={5}>5 交易日</option>
          <option value={20}>20 交易日</option>
        </select>
      </div>
      <div className="investment-metrics">
        <div>{complete.length === rows.length ? "窗口净申购" : "完整标的合计"}<strong className={total >= 0 ? "investment-up" : "investment-down"}>{complete.length ? `${total > 0 ? "+" : ""}${formatMoney(total / 1e8)}` : "—"}<small>亿元</small></strong></div>
        <div>净流入标的<strong>{complete.filter(r => r.flow.total! > 0).length}<small>/ {complete.length} 只有效</small></strong></div>
        <div>完整数据覆盖<strong>{complete.length}<small>/ {rows.length} 只</small></strong></div>
      </div>
      <div className="investment-section-title"><h2>资金去向</h2><span>{days} 个交易日</span></div>
      <div className="investment-flow-bars">{rows.map(({ instrument, flow }) => <button key={instrument.code} onClick={() => onSelect(instrument.code)}>
        <span>{instrument.name}<small>{instrument.code}</small></span>
        <span className="investment-flow-track"><i className={flow.total != null && flow.total < 0 ? "is-negative" : ""} style={{ width: `${flow.total == null ? 0 : Math.abs(flow.total) / maximum * 100}%` }} /></span>
        <strong className={flow.total != null && flow.total < 0 ? "investment-down" : "investment-up"}>{flow.total == null ? "数据不足" : `${flow.total > 0 ? "+" : ""}${formatMoney(flow.total / 1e8)}`}</strong>
      </button>)}</div>
      <div className="investment-section-title"><h2>窗口明细</h2><span>缺口标的不参与排名</span></div>
      <div className="investment-table">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>净申购 / 亿元</th>
              <th>有效日 / 窗口</th>
              <th>所属日</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ instrument: i, flow: f }) => {
              return (
                <tr key={i.code}>
                  <td>
                    <button className="investment-link" onClick={() => onSelect(i.code)}>
                      {i.name}
                      <small>{i.code}</small>
                    </button>
                  </td>
                  <td>
                    {f.total == null ? "数据不足" : formatMoney(f.total / 1e8)}
                  </td>
                  <td>
                    {f.count} / {days}
                  </td>
                  <td>{f.date}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details><summary>统计口径与数据限制</summary><p>份额差 × 当日净值；不等于二级市场资金流，不能拆分总申购与总赎回。缺失不填零，20 日窗口需持续积累，份额突变需核验拆分等事件。</p></details>
    </>
  );
}
export function MarketView({
  instrument,
  onBacktest,
}: {
  instrument: Instrument;
  onBacktest: () => void;
}) {
  const last = instrument.bars.at(-1);
  const previous = instrument.bars.at(-2);
  const change = last && previous ? last.close / previous.close - 1 : 0;
  return (
    <>
      <h1>{instrument.name}</h1>
      <div className="investment-quote"><div><strong className={change >= 0 ? "investment-up" : "investment-down"}>{last?.close.toFixed(3) ?? "—"}</strong><span className={change >= 0 ? "investment-up" : "investment-down"}>{change > 0 ? "+" : ""}{(change * 100).toFixed(2)}%</span></div><span>{instrument.code}</span><span>开 {last?.open.toFixed(3)}</span><span>高 {last?.high.toFixed(3)}</span><span>低 {last?.low.toFixed(3)}</span><span>成交 {formatMoney(last ? last.volume / 1e4 : null)} 万份</span></div>
      <Candles bars={instrument.bars} />
      <details>
        <summary>查看原始行情与资金证据</summary>
        <div className="investment-table">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>收盘 / 元</th>
                <th>成交量 / 份</th>
                <th>份额 / 亿份</th>
                <th>净值 / 元</th>
              </tr>
            </thead>
            <tbody>
              {instrument.bars
                .slice(-30)
                .reverse()
                .map((b) => {
                  const f = instrument.funds.find((f) => f.date === b.date);
                  return (
                    <tr key={b.date}>
                      <td>{b.date}</td>
                      <td>{b.close.toFixed(3)}</td>
                      <td>{formatMoney(b.volume)}</td>
                      <td>
                        {formatMoney(f?.shares == null ? null : f.shares / 1e8)}
                      </td>
                      <td>{formatMoney(f?.nav)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </details>
      <button onClick={onBacktest}>回测研究池 →</button>
    </>
  );
}
export function DataView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <>
      <h1>数据中心</h1>
      <p>最近采集 {new Date(snapshot.createdAt).toLocaleString()}</p>
      <DataSources snapshot={snapshot} />
      <div className="investment-table">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>行情覆盖</th>
              <th>行情条数</th>
              <th>份额观察点</th>
              <th>完整流量点</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.instruments.map((i) => (
              <tr key={i.code}>
                <td>{i.name}</td>
                <td>
                  {i.bars[0]?.date} → {i.bars.at(-1)?.date}
                </td>
                <td>{i.bars.length}</td>
                <td>{i.funds.filter((f) => f.shares != null).length}</td>
                <td>{i.funds.filter((f) => f.netFlow != null).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="investment-section">
        <h2>质量与接入状态</h2>
        {snapshot.warnings.length ? (
          <ul>
            {snapshot.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : (
          <p>本次接口未返回缺口警告。</p>
        )}
        <details><summary>数据存储与历史可用性</summary><p>资金采用本地首次观察时间。原响应和快照保存于应用数据目录 investment，刷新不覆盖已有实验。当前仅支持免费源和固定研究池；完整公司行为校验尚未开放。</p></details>
      </section>
    </>
  );
}
