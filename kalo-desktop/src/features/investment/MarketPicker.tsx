import { useEffect, useState } from "react";
import type { Dataset } from "./code-types";
import type { Request } from "./types";
import { ResearchSelect } from "./ResearchSelect";
export type MarketRequest = Extract<Request, { operation: "marketSync" }>;

export default function MarketPicker({ data, busy, onSync, onSelection }: { data?: Dataset; busy: boolean; onSync: (request: MarketRequest) => void; onSelection: (request: MarketRequest) => void }) {
  const [code, setCode] = useState(data?.security.code ?? "");
  const [timeframe, setTimeframe] = useState<MarketRequest["timeframe"]>("5m");
  const [settlement, setSettlement] = useState("default");
  useEffect(() => {
    if (data) { setCode(data.security.code); setTimeframe(data.timeframe as MarketRequest["timeframe"]); setSettlement(data.security.settlementDays === 0 ? "0" : "default"); }
  }, [data?.id]);
  useEffect(() => onSelection({ operation: "marketSync", code: code.trim(), timeframe, ...(settlement === "0" ? { settlementDays: 0 } : {}) }), [code, timeframe, settlement, onSelection]);
  const valid = /^\d{6}(\.(SH|SZ|BJ))?$/i.test(code.trim());
  return <div className="investment-market-picker">
    <label>证券代码<input aria-label="策略证券代码" placeholder="输入任意 A 股或 ETF 代码" maxLength={9} value={code} onChange={e => setCode(e.target.value)} /></label>
    <label>K 线周期<ResearchSelect label="分钟周期" value={timeframe} onChange={v => setTimeframe(v as MarketRequest["timeframe"])} options={[5,15,30,60].map(n => ({ value: `${n}m`, label: `${n} 分钟` }))} /></label>
    <label>库存规则<ResearchSelect label="库存规则" value={settlement} onChange={setSettlement} options={[{value:"default",label:"T+1（默认）",detail:"股票及股票ETF；当日买入次日可卖"},{value:"0",label:"T+0 ETF",detail:"仅在确认基金支持日内回转时选择"}]} /></label>
    <button className="investment-primary" disabled={busy || !valid} onClick={() => onSync({operation:"marketSync",code:code.trim(),timeframe,...(settlement === "0" ? {settlementDays:0} : {})})}>{busy ? "正在同步…" : "同步分钟数据"}</button>
    <span className="investment-footnote">免费历史最多 1970 根，本地连续历史自动积累；更长区间可选 30 或 60 分钟。</span>
  </div>;
}
