import { useEffect, useMemo, useRef, useState } from "react";
import type { Dataset, ScriptReport, ScriptSpec } from "./code-types";
import { codeDefaults, researchContext, type ResearchContext } from "./code-logic";
import { copyExperiment, draftStorageKey, isScriptSpec, parseDrafts, putDraft, type CodeView, type ExperimentDraft } from "./experiment-drafts";
import type { MarketRequest } from "./MarketPicker";
import ExperimentCreate from "./ExperimentCreate";
import ExperimentEditor from "./ExperimentEditor";
import ScriptReportView from "./ScriptReport";
import AppIcon from "../../components/AppIcon";

export default function CodeLab({ datasets, reports, datasetId, reportId, example, busy, view, onView, onDataset, onReport, onSync, onRun, onContext, onAsk }: {
  datasets: Dataset[]; reports: ScriptReport[]; datasetId: string; reportId: string; example: string; busy: boolean;
  view: CodeView | null; onView: (view: CodeView) => void;
  onDataset: (id: string) => void; onReport: (id: string) => void; onSync: (request: MarketRequest) => void; onRun: (spec: ScriptSpec) => void;
  onContext: (context: ResearchContext) => void; onAsk: () => void;
}) {
  const [library, setLibrary] = useState(() => {
    try { return { drafts: parseDrafts(localStorage.getItem(draftStorageKey)), error: "" }; }
    catch { return { drafts: [] as ExperimentDraft[], error: "本机草稿库读取失败，已保留原存储。请先备份或修复草稿库，再创建或修改实验。" }; }
  });
  const [saveError, setSaveError] = useState("");
  const legacy = useMemo(() => {
    const drafts: ExperimentDraft[] = [], errors: string[] = [];
    for (const data of datasets) {
      try {
        const raw = localStorage.getItem(`kalo.investment.code.${data.id}`);
        if (!raw) continue;
        const saved: unknown = JSON.parse(raw);
        const spec = saved && typeof saved === "object" ? { ...codeDefaults(data, example), ...saved } : null;
        if (!isScriptSpec(spec) || spec.datasetId !== data.id) throw new Error("invalid draft");
        drafts.push(copyExperiment(`legacy:${data.id}`, data.createdAt, spec));
      } catch { errors.push(`${data.security.name} 的旧草稿未能读取，原存储已保留。`); }
    }
    return { drafts, errors };
  }, [datasets, example]);
  const drafts = [...library.drafts, ...legacy.drafts.filter(d => !library.drafts.some(saved => saved.id === d.id))];
  const initialReport = reports.find(r => r.id === reportId) ?? reports[0];
  const current = view ?? (initialReport ? { kind: "report", id: initialReport.id } as const : { kind: "records" } as const);
  const selectedReport = current.kind === "report" ? reports.find(r => r.id === current.id) : undefined;
  const draft = current.kind === "edit" ? drafts.find(d => d.id === current.id) : undefined;
  const data = datasets.find(d => d.id === draft?.spec.datasetId);
  const top = useRef<HTMLDivElement>(null);
  const selectionId = "id" in current ? current.id : "";
  useEffect(() => { top.current?.closest(".investment-main")?.scrollTo({ top: 0 }); }, [current.kind, selectionId]);
  useEffect(() => {
    if (current.kind === "report" && selectedReport) onContext(researchContext(`${selectedReport.security.name} / 回测结果`, { page: "code", mode: "report", reportId: selectedReport.id, datasetId: selectedReport.spec.datasetId, spec: selectedReport.spec, excessPnl: selectedReport.excessPnl, costs: selectedReport.costs }));
    else if (current.kind === "records") onContext(researchContext("实验记录", { page: "code", mode: "records", instruction: "尚未选中实验，请先明确要继续的草稿或报告。" }));
    else if (current.kind === "edit" && (!draft || !data)) onContext(researchContext("实验数据不可用", { page: "code", mode: "missing", draftId: selectionId, instruction: "不能用其他数据集替代当前草稿的数据。" }));
  }, [current.kind, selectedReport, draft, data, selectionId, onContext]);
  const save = (next: ExperimentDraft) => {
    if (library.error) return;
    const updated = putDraft(drafts, next);
    setLibrary({ drafts: updated, error: "" });
    try { localStorage.setItem(draftStorageKey, JSON.stringify({ version: 1, drafts: updated })); setSaveError(""); }
    catch { setSaveError("草稿未能保存到本机，请复制代码后再离开此页。原有存储未被清空。"); }
  };
  const create = (spec: ScriptSpec) => {
    if (library.error) return;
    const next = copyExperiment(crypto.randomUUID(), new Date().toISOString(), spec);
    save(next); onDataset(spec.datasetId); onView({ kind: "edit", id: next.id });
  };
  const openReport = (r: ScriptReport) => { onDataset(r.spec.datasetId); onReport(r.id); onView({ kind: "report", id: r.id }); };
  const records = () => onView({ kind: "records" });
  return <div ref={top} className="experiment-workspace">
    {(library.error || saveError) && <p className="investment-warning" role="alert">{library.error || saveError}</p>}
    {current.kind === "create" ? <ExperimentCreate datasets={datasets} datasetId={datasetId} example={example} busy={busy || !!library.error} onDataset={onDataset} onSync={onSync} onCreate={create} onCancel={records} onContext={onContext} /> : current.kind === "edit" && draft && data ? <ExperimentEditor key={draft.id} draft={draft} data={data} busy={busy || !!library.error} saveError={saveError} onChange={spec => save({ ...draft, updatedAt: new Date().toISOString(), spec })} onRun={onRun} onContext={onContext} onAsk={onAsk} onRecords={records} /> : current.kind === "report" && selectedReport ? <>
      <div className="experiment-toolbar"><span className="experiment-state">已完成回测</span><div className="investment-controls"><button onClick={records}>实验记录</button><button disabled={busy || !!library.error || !datasets.some(d => d.id === selectedReport.spec.datasetId)} onClick={() => create(selectedReport.spec)}>继续修改</button></div></div>
      {!datasets.some(d => d.id === selectedReport.spec.datasetId) && <p className="investment-warning">原数据集已不在当前目录，报告仍可阅读；继续修改需要原冻结数据集。</p>}
      <ScriptReportView key={selectedReport.id} report={selectedReport} />
    </> : <>
      <div className="investment-page-heading"><h1>实验记录</h1><button disabled={busy || !!library.error} onClick={() => onView({ kind: "create" })}><AppIcon name="plus" size={16} />新建代码实验</button></div>
      {current.kind === "edit" && <p className="investment-warning">草稿或原数据集不可用，已保留草稿，不会切换为其他证券。</p>}
      {legacy.errors.map(message => <p className="investment-warning" key={message}>{message}</p>)}
      <section className="experiment-records"><h2>草稿 <span>{drafts.length}</span></h2>
        {drafts.map(d => { const dataset = datasets.find(item => item.id === d.spec.datasetId); return <button key={d.id} disabled={!dataset || busy || !!library.error} onClick={() => { onDataset(d.spec.datasetId); onView({ kind: "edit", id: d.id }); }}><span><strong>{d.spec.title || "未命名策略"}</strong><small>{dataset ? `${dataset.security.name} / ${dataset.timeframe}` : "原数据集不可用"}</small></span><span>{new Date(d.updatedAt).toLocaleString()}<small>继续编辑</small></span></button>; })}
        {!drafts.length && <p className="investment-footnote">尚无草稿，从新建实验开始。</p>}
      </section>
      <section className="experiment-records"><h2>已完成 <span>{reports.length}</span></h2>{reports.map(r => <button key={r.id} onClick={() => openReport(r)}><span><strong>{r.spec.title}</strong><small>{r.security.name} / {r.timeframe ?? "5m"}</small></span><span>{new Date(r.createdAt).toLocaleString()}<small>查看结果</small></span></button>)}{!reports.length && <p className="investment-footnote">完成回测后，报告会保存在这里。</p>}</section>
    </>}
  </div>;
}
