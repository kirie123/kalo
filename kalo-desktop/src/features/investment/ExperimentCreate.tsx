import { useEffect, useState } from "react";
import type { Dataset, ScriptSpec } from "./code-types";
import { codeDefaults, researchContext, type ResearchContext } from "./code-logic";
import { ResearchSelect } from "./ResearchSelect";
import MarketPicker, { type MarketRequest } from "./MarketPicker";
import ExperimentIdea from "./ExperimentIdea";

const emptySource = 'fn on_bar(ctx) {\n    #{ side: "hold", quantity: 0, state: ctx.state }\n}';
export default function ExperimentCreate({ datasets, datasetId, example, busy, manualUnavailable, onDataset, onSync, onCreate, onCancel, onContext, onAsk }: {
  datasets: Dataset[]; datasetId: string; example: string; busy: boolean; manualUnavailable: boolean;
  onDataset: (id: string) => void; onSync: (request: MarketRequest) => void;
  onCreate: (spec: ScriptSpec) => void; onCancel: () => void; onContext: (context: ResearchContext) => void; onAsk: () => void;
}) {
  const data = datasets.find(d => d.id === datasetId) ?? datasets[0];
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("kdj");
  const [syncOpen, setSyncOpen] = useState(false);
  const [request, setRequest] = useState<MarketRequest>({ operation: "marketSync", code: "", timeframe: "5m" });
  const title = name.trim() || (data ? `${data.security.name} ${template === "kdj" ? "KDJ 底仓做T" : "自定义策略"}` : "新策略");
  useEffect(() => {
    if (!manual) return;
    onContext(researchContext("新建实验", { page: "code", mode: "create", title, template, datasetId: data?.id, security: data?.security, timeframe: data?.timeframe, ...((syncOpen || !data) ? { pendingSync: request } : {}), instruction: "这是尚未创建的实验，请围绕当前选择帮助设计策略。" }));
  }, [manual, title, template, data, request, syncOpen, onContext]);
  return <section className="experiment-create">
    <div className="investment-page-heading"><h1>新建实验</h1><button onClick={onCancel}>返回实验记录</button></div>
    {!manual ? <><ExperimentIdea busy={busy} onAsk={onAsk} onContext={onContext} /><div className="experiment-entry-switch"><button onClick={() => setManual(true)}>手动配置数据与代码</button></div></> : <>
    <div className="experiment-entry-switch"><button onClick={() => setManual(false)}>返回自然语言创建</button></div>
    <div className="experiment-create-fields">
      <label>实验名称<input autoFocus aria-label="实验名称" value={name} placeholder={title} maxLength={100} onChange={e => setName(e.target.value)} /></label>
      {data && <label>研究数据<ResearchSelect label="分钟数据集" value={data.id} onChange={onDataset} options={datasets.map(d => ({ value: d.id, label: `${d.security.name} / ${d.timeframe}`, detail: `${d.sessions[0]} → ${d.sessions.at(-1)} / ${d.bars.length} 根 / ${d.id.slice(0, 8)}` }))} /></label>}
      {data && <p className="investment-footnote">{data.security.code} / {data.sessions[0]} — {data.sessions.at(-1)} / {data.sessions.length} 个交易日</p>}
      <label>策略起点<ResearchSelect label="策略起点" value={template} onChange={setTemplate} options={[{ value: "kdj", label: "KDJ 底仓做 T", detail: "带初始底仓的示例，可交给助手修改" }, { value: "empty", label: "空白策略", detail: "保留 on_bar 入口，初始不产生交易信号" }]} /></label>
    </div>
    <details className="experiment-sync" open={syncOpen || !data} onToggle={e => setSyncOpen(e.currentTarget.open)}><summary>{data ? "同步其他证券或周期" : "先同步研究数据"}</summary><MarketPicker data={data} busy={busy} onSync={onSync} onSelection={setRequest} /></details>
    <div className="experiment-create-actions"><button className="investment-primary" disabled={busy || manualUnavailable || !data || (template === "kdj" && !example)} onClick={() => { if (data) onCreate({ ...codeDefaults(data, template === "kdj" ? example : emptySource), title }); }}>创建并编写策略</button></div>
    </>}
  </section>;
}
