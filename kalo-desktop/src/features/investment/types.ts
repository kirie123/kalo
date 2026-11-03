import type { Dataset, ScriptReport, ScriptSpec } from "./code-types";
import type { MarginSnapshot } from "./margin-logic";
export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjustedClose: number;
  volume: number;
}
export interface FundPoint {
  date: string;
  shares: number | null;
  nav: number | null;
  netFlow: number | null;
  availableAt: string;
}
export interface Instrument {
  code: string;
  name: string;
  category?: string;
  bars: Bar[];
  funds: FundPoint[];
}
export interface Snapshot {
  id: string;
  createdAt: string;
  source: string;
  instruments: Instrument[];
  warnings: string[];
}
export interface Spec {
  snapshotId: string;
  codes?: string[];
  start: string;
  end: string;
  capital: number;
  lookback: number;
  rebalance: number;
  holdings: number;
  commissionBps: number;
  minimumFee: number;
  slippageBps: number;
  flowFilter: boolean;
}
export interface Equity {
  date: string;
  equity: number;
  cash: number;
  benchmark: number;
  drawdown: number;
}
export interface Trade {
  date: string;
  code: string;
  side: string;
  quantity: number;
  price: number;
  fee: number;
  cashAfter: number;
  reason: string;
}
export interface Report {
  id: string;
  createdAt: string;
  snapshotHash: string;
  engineVersion: string;
  engineHash?: string;
  spec: Spec;
  equity: Equity[];
  trades: Trade[];
  totalReturn: number;
  maxDrawdown: number;
  fees: number;
  warnings: string[];
}
export interface Catalog {
  snapshots: Snapshot[];
  reports: Report[];
  datasets?: Dataset[];
  scriptReports?: ScriptReport[];
  marginSnapshots?: MarginSnapshot[];
  strategyRuntime?: { example: string };
}
export interface JobStatus {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: string;
  error: string | null;
  result: Snapshot | Report | Dataset | ScriptReport | MarginSnapshot | null;
}
export type Request =
  | { operation: "sync" }
  | { operation: "marginSync" }
  | { operation: "backtest"; spec: Spec }
  | { operation: "marketSync"; code: string; timeframe: "5m" }
  | { operation: "scriptBacktest"; spec: ScriptSpec };

export interface Activity {
  focus: {
    revision: number;
    page: string;
    snapshotId: string | null;
    reportId: string | null;
    datasetId?: string | null;
    scriptReportId?: string | null;
    marginSnapshotId?: string | null;
    days: number | null;
    jobId: string | null;
    owner: string | null;
  };
  job: JobStatus | null;
}
