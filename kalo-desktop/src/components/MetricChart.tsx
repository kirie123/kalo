/**
 * A small multi-series line/scatter chart.
 *
 * Deliberately generic and dependency-free: it knows about points, axes and a
 * hovered index, and nothing about evolution runs. Any panel that has numbers
 * over an integer axis can use it.
 *
 * SVG rather than canvas so that hit-testing, theming (`currentColor`,
 * CSS variables) and copy-as-image all come for free.
 */

import { useMemo, useState } from "react";

export interface ChartPoint {
  x: number;
  y: number;
  /** Free-form payload handed back to `onSelect` / the tooltip renderer. */
  key?: string | number;
}

export interface ChartSeries {
  id: string;
  label: string;
  points: ChartPoint[];
  /** CSS colour. Defaults to the ink colour. */
  color?: string;
  /** "line" joins the points in order; "scatter" draws markers only. */
  shape?: "line" | "scatter";
  /** Draw the line dashed — used for a reference series such as a holdout. */
  dashed?: boolean;
}

interface MetricChartProps {
  series: ChartSeries[];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  /** Shown under the title; the place to explain what a higher value means. */
  subtitle?: string;
  /** Emitted when a point is clicked, with the series id and the point. */
  onSelect?: (seriesId: string, point: ChartPoint) => void;
  /** Highlighted point, matched on `key` across all series. */
  selectedKey?: string | number | null;
  emptyHint?: string;
}

const PAD = { top: 8, right: 10, bottom: 22, left: 44 };

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/** Compact axis labels: 12345678 -> 1.23e7, 0.5 -> 0.5. */
function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(1);
  return String(Math.round(v * 1000) / 1000);
}

export default function MetricChart({
  series,
  height = 200,
  xLabel,
  yLabel,
  subtitle,
  onSelect,
  selectedKey = null,
  emptyHint = "还没有数据",
}: MetricChartProps) {
  const [hover, setHover] = useState<{ s: ChartSeries; p: ChartPoint } | null>(null);
  const width = 640; // viewBox units; the SVG scales to its container.

  const bounds = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of series) {
      for (const p of s.points) {
        if (Number.isFinite(p.x)) xs.push(p.x);
        if (Number.isFinite(p.y)) ys.push(p.y);
      }
    }
    if (xs.length === 0) return null;
    let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    // A flat series (one point, or every score equal) would divide by zero.
    if (x1 === x0) [x0, x1] = [x0 - 0.5, x1 + 0.5];
    if (y1 === y0) {
      const pad = Math.abs(y0) * 0.05 || 1;
      [y0, y1] = [y0 - pad, y1 + pad];
    } else {
      const pad = (y1 - y0) * 0.08;
      [y0, y1] = [y0 - pad, y1 + pad];
    }
    return { x0, x1, y0, y1 };
  }, [series]);

  if (!bounds) {
    return (
      <div className="rounded-lg border border-edge bg-base px-3 py-6 text-center text-xs text-dim">{emptyHint}</div>
    );
  }

  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const sx = (x: number) => PAD.left + ((x - bounds.x0) / (bounds.x1 - bounds.x0)) * iw;
  const sy = (y: number) => PAD.top + ih - ((y - bounds.y0) / (bounds.y1 - bounds.y0)) * ih;

  const yTicks = niceTicks(bounds.y0, bounds.y1);
  const xTicks = niceTicks(bounds.x0, bounds.x1, 6).filter((v) => Number.isInteger(v));

  return (
    <div>
      {subtitle && <div className="mb-1 text-[11px] text-dim">{subtitle}</div>}
      <div className="relative rounded-lg border border-edge bg-base">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} role="img">
          {/* horizontal grid + y ticks */}
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={sy(t)}
                y2={sy(t)}
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={1}
              />
              <text x={PAD.left - 6} y={sy(t) + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.55}>
                {fmtTick(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={`x${t}`}
              x={sx(t)}
              y={height - 8}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              opacity={0.55}
            >
              {fmtTick(t)}
            </text>
          ))}

          {series.map((s) => {
            const color = s.color ?? "currentColor";
            const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
            const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x)},${sy(p.y)}`).join(" ");
            return (
              <g key={s.id}>
                {s.shape !== "scatter" && pts.length > 1 && (
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                  />
                )}
                {pts.map((p, i) => {
                  const on = selectedKey != null && p.key === selectedKey;
                  return (
                    <circle
                      key={`${s.id}-${i}`}
                      cx={sx(p.x)}
                      cy={sy(p.y)}
                      r={on ? 4.5 : 2.6}
                      fill={color}
                      stroke={on ? "currentColor" : "none"}
                      strokeWidth={1}
                      className={onSelect ? "cursor-pointer" : undefined}
                      onMouseEnter={() => setHover({ s, p })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => onSelect?.(s.id, p)}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>

        {hover && (
          <div className="pointer-events-none absolute right-2 top-2 rounded border border-edge bg-card px-2 py-1 text-[10px] text-ink shadow">
            {hover.s.label} · {xLabel ?? "x"}={fmtTick(hover.p.x)} · {yLabel ?? "y"}={fmtTick(hover.p.y)}
          </div>
        )}
      </div>

      {series.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-3">
          {series.map((s) => (
            <span key={s.id} className="flex items-center gap-1 text-[10px] text-dim">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.color ?? "currentColor" }}
              />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
