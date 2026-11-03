import type { Bar, Report } from "./types";
import { formatMoney } from "./logic";
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span>—</span>;
  const low = Math.min(...values), high = Math.max(...values);
  const points = values.map((v, i) => `${i / (values.length - 1) * 112},${28 - (v - low) / (high - low || 1) * 24}`).join(" ");
  return <svg className="investment-sparkline" viewBox="0 0 112 32" role="img" aria-label="60 日收盘走势"><polyline points={points} fill="none" stroke="var(--text-dim)" strokeWidth="1.5" /></svg>;
}
export function Candles({ bars }: { bars: Bar[] }) {
  const points = bars.slice(-60);
  if (!points.length) return <p>没有行情</p>;
  const lo = Math.min(...points.map((b) => b.low)),
    hi = Math.max(...points.map((b) => b.high));
  const y = (n: number) => 230 - ((n - lo) / (hi - lo || 1)) * 210;
  const maxVolume = Math.max(1, ...points.map(b => b.volume));
  return (
    <div>
      <svg
        className="investment-chart"
        viewBox="0 0 900 330"
        role="img"
        aria-label="最近60个交易日未复权K线，红涨绿跌"
      >
        {[0, 1, 2, 3, 4].map(t => <g key={t}><line x1="0" y1={20 + t * 52.5} x2="840" y2={20 + t * 52.5} stroke="var(--border)" strokeDasharray="3 5" /><text x="850" y={24 + t * 52.5} fill="var(--text-dim)" fontSize="12">{(hi - (hi - lo) * t / 4).toFixed(3)}</text></g>)}
        {points.map((b, i) => {
          const x = 10 + (i * 820) / points.length;
          const color = b.close >= b.open ? "var(--danger)" : "var(--ok)";
          return (
            <g key={b.date}>
              <title>{`${b.date} 开 ${b.open} 高 ${b.high} 低 ${b.low} 收 ${b.close} 成交量 ${formatMoney(b.volume)} 份`}</title>
              <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={color} />
              <rect
                x={x - 4}
                y={Math.min(y(b.open), y(b.close))}
                width={8}
                height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                fill={color}
              />
              <rect x={x - 4} y={310 - b.volume / maxVolume * 50} width={8} height={b.volume / maxVolume * 50} fill={color} opacity=".45" />
            </g>
          );
        })}
      </svg>
      <div className="investment-between">
        <span>{points[0].date}</span>
        <span>
          未复权价格 / 成交量
        </span>
        <span>{points.at(-1)?.date}</span>
      </div>
    </div>
  );
}
export function EquityChart({ report }: { report: Report }) {
  const points = report.equity;
  const all = [
    report.spec.capital,
    ...points.flatMap((p) => [p.equity, p.benchmark]),
  ];
  const lo = Math.min(...all),
    hi = Math.max(...all);
  const path = (key: "equity" | "benchmark") =>
    [report.spec.capital, ...points.map((p) => p[key])]
      .map(
        (v, i) =>
          `${i ? "L" : "M"}${(i / points.length) * 880 + 10},${220 - ((v - lo) / (hi - lo || 1)) * 200}`,
      )
      .join(" ");
  return (
    <div>
      <div className="investment-between">
        <span className="investment-chart-legend"><i />成本后策略<i className="benchmark" />沪深300 ETF 基准</span>
        <span>
          资产范围 {formatMoney(lo)}–{formatMoney(hi)} 元
        </span>
      </div>
      <svg
        className="investment-chart"
        viewBox="0 0 900 240"
        role="img"
        aria-label="策略与买入持有基准资产曲线"
      >
        {[0, 1, 2, 3, 4].map(t => <line key={t} x1="10" y1={20 + t * 50} x2="890" y2={20 + t * 50} stroke="var(--border)" strokeDasharray="3 5" />)}
        <path
          d={path("equity")}
          fill="none"
          stroke="var(--text)"
          strokeWidth="2"
        />
        <path
          d={path("benchmark")}
          fill="none"
          stroke="var(--tone-blue)"
          strokeWidth="2"
        />
      </svg>
      <div className="investment-between">
        <span>{points[0]?.date}</span>
        <span>{points.at(-1)?.date}</span>
      </div>
    </div>
  );
}
