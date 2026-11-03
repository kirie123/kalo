import { useCallback, useEffect, useRef, useState } from "react";
import {
  investmentCancel,
  investmentCatalog,
  investmentStart,
  investmentStatus,
  investmentActivity,
} from "../../lib/pi-bridge";
import type { Catalog, JobStatus, Request, Spec } from "./types";
import { BacktestForm, ReportView } from "./Backtest";
import { DataView, FlowView, MarketView } from "./DataViews";
import "./investment.css";
import "./research.css";
import "./controls.css";
import { ResearchSelect } from "./ResearchSelect";
import InvestmentAssistant from "./InvestmentAssistant";
import AppIcon, { type IconName } from "../../components/AppIcon";
import ResearchOverview, { ResearchEmpty } from "./ResearchOverview";
import CodeLab from "./CodeLab";
import type { CodeView } from "./experiment-drafts";
import MarginView from "./MarginView";
import { researchContext, type ResearchContext } from "./code-logic";
import "./code-lab.css";
const pageIcons: Record<string, IconName> = { home: "overview", flows: "chart", margin: "chart", charts: "candles", backtest: "checklist", code: "flask", data: "database" };
const pages = [
  ["home", "总览"],
  ["flows", "ETF 资金"],
  ["margin", "两融观察"],
  ["charts", "行情研究"],
  ["backtest", "策略回测"],
  ["code", "代码策略"],
  ["data", "数据中心"],
];
const navigation = [["home", "总览"], ["charts", "市场研究"], ["code", "策略实验"], ["data", "数据中心"]];
const marketPages = ["charts", "flows", "margin"];
const strategyPages = ["code", "backtest"];
export default function InvestmentPanel({ assistantOpen, onAssistantChange: setAssistantOpen }: { assistantOpen: boolean; onAssistantChange: (open: boolean) => void }) {
  const [page, setPage] = useState("home");
  const [codeView, setCodeView] = useState<CodeView | null>(null);
  const manualNavigation = useRef(false);
  const navigate = (next: string) => { manualNavigation.current = true; setPage(next); };
  const [catalog, setCatalog] = useState<Catalog>({
    snapshots: [],
    reports: [],
  });
  const [snapshotId, setSnapshotId] = useState("");
  const [reportId, setReportId] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [page]);
  const reportAnchor = useRef<HTMLDivElement>(null);
  useEffect(() => { if (reportId) reportAnchor.current?.scrollIntoView({ block: "start" }); }, [reportId]);
  const [instrumentCode, setInstrumentCode] = useState("510300.SH");
  const [jobId, setJobId] = useState(
    () => localStorage.getItem("kalo.investment.job") ?? "",
  );
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [datasetId, setDatasetId] = useState("");
  const [scriptReportId, setScriptReportId] = useState("");
  const scriptResultSeen = useRef("");
  const revealScriptReport = useCallback((id: string, restoring = false) => {
    if (scriptResultSeen.current === id) return;
    scriptResultSeen.current = id;
    setScriptReportId(id);
    setCodeView(previous => restoring && previous ? previous : { kind: "report", id });
  }, []);
  const [marginId, setMarginId] = useState("");
  const [marginContext, setMarginContext] = useState<ResearchContext>(researchContext("两融观察", { page: "margin" }));
  const [flowContext, setFlowContext] = useState({ days: 5, category: "全部" });
  const [overviewCategory, setOverviewCategory] = useState("全部");
  const [backtestDraft, setBacktestDraft] = useState<Spec | undefined>();
  const [codeContext, setCodeContext] = useState<ResearchContext>(researchContext("代码策略", { page: "code", selection: "尚未选择证券与数据集" }));
  const [configOpen, setConfigOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const lastRequest = useRef<Request | null>(null);
  const lastStartedJob = useRef("");
  const [flowDays, setFlowDays] = useState(5);
  const [activityRevision, setActivityRevision] = useState(0);
  const activitySeen = useRef(0);
  const snapshot =
    catalog.snapshots.find((s) => s.id === snapshotId) ?? catalog.snapshots[0];
  const report =
    catalog.reports.find((r) => r.id === reportId) ?? catalog.reports[0];
  const instrument =
    snapshot?.instruments.find((i) => i.code === instrumentCode) ??
    snapshot?.instruments[0];
  const busy = submitting || !!jobId;
  const refresh = useCallback(async () => {
    const next = await investmentCatalog();
    setCatalog(next);
    return next;
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const activity = await investmentActivity();
        if (stopped) return;
        const focus = activity.focus;
        if (focus.revision > activitySeen.current) {
          const restoring = activitySeen.current === 0;
          await refresh();
          if (stopped) return;
          activitySeen.current = focus.revision;
          setActivityRevision(focus.revision);
          if (activity.job && !activity.job.error) setError("");
          if (activity.job?.status !== "running") setCancelPending(false);
          const preserveView = (restoring && manualNavigation.current) || (!!focus.scriptReportId && scriptResultSeen.current === focus.scriptReportId);
          if (!preserveView) {
            if (focus.snapshotId) setSnapshotId(focus.snapshotId);
            if (focus.datasetId) setDatasetId(focus.datasetId);
            if (focus.marginSnapshotId) setMarginId(focus.marginSnapshotId);
            if (focus.reportId) { setReportId(focus.reportId); setConfigOpen(false); }
            if (focus.days) setFlowDays(focus.days);
            if (pages.some(([id]) => id === focus.page)) setPage(focus.page);
          }
          if (focus.scriptReportId) revealScriptReport(focus.scriptReportId, restoring);
          if (activity.job) {
            if (activity.job.id !== lastStartedJob.current) lastRequest.current = null;
            setStatus(activity.job);
            if (activity.job.error) setError(activity.job.error);
            if (activity.job.status === "running") {
              localStorage.setItem("kalo.investment.job", activity.job.id);
              setJobId(activity.job.id);
            }
          }
        }
      } catch (e) {
        if (!stopped) setError(`投行任务状态同步失败：${String(e)}`);
      } finally {
        if (!stopped) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, revealScriptReport]);
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await investmentStatus(jobId);
        if (stopped) return;
        setStatus(next);
        if (next.status !== "running") setCancelPending(false);
        if (next.status === "running") {
          timer = setTimeout(poll, 700);
          return;
        }
        if (next.error) setError(next.error);
        await refresh();
        if (stopped) return;
        if (next.result && "instruments" in next.result)
          setSnapshotId(next.result.id);
        if (next.result && "kind" in next.result) {
          if (next.result.kind === "marginSnapshot") { setMarginId(next.result.id); setPage("margin"); }
          else {
            if (next.result.kind === "marketDataset") setDatasetId(next.result.id);
            else if (scriptResultSeen.current !== next.result.id) { revealScriptReport(next.result.id); setDatasetId(next.result.spec.datasetId); setPage("code"); }
            if (next.result.kind === "marketDataset") setPage("code");
          }
        } else if (next.result && "spec" in next.result) {
          setReportId(next.result.id);
          setConfigOpen(false);
          setPage("backtest");
        }
        localStorage.removeItem("kalo.investment.job");
        setJobId("");
      } catch (e) {
        if (!stopped) {
          setError(String(e));
          setJobId("");
          localStorage.removeItem("kalo.investment.job");
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, refresh, revealScriptReport]);
  const start = async (request: Request) => {
    if (busy) return;
    lastRequest.current = request;
    setCancelPending(false);
    setStatus(null);
    setSubmitting(true);
    setError("");
    try {
      const id = await investmentStart(request);
      lastStartedJob.current = id;
      localStorage.setItem("kalo.investment.job", id);
      setJobId(id);
      setStatus(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };
  const selectInstrument = (code: string) => {
    setInstrumentCode(code);
    navigate("charts");
  };
  const context = page === "code" ? codeContext : page === "margin" ? marginContext : researchContext(pages.find(([id]) => id === page)?.[1] ?? "投行", {
    page, snapshotId: snapshot?.id, coverage: snapshot?.instruments[0]?.bars.at(-1)?.date,
    ...(page === "charts" ? { instrument: instrument?.code, name: instrument?.name } : {}),
    ...(page === "flows" ? flowContext : {}),
    ...(page === "home" ? { category: overviewCategory } : {}),
    ...(page === "backtest" ? { reportId: report?.id, reportSpec: report?.spec, ...(configOpen ? { draft: backtestDraft } : {}) } : {}),
  });
  return (
    <div className="investment-shell">
    <div className={`investment ${collapsed ? "investment-collapsed" : ""}`}>
      <aside className="investment-sidebar">
        <div className="investment-between">
          <h1>投行</h1>
          <button aria-label="收起投行导航" onClick={() => setCollapsed(true)}>
            <AppIcon name="chevronLeft" size={16} />
          </button>
        </div>
        <button
          className="investment-primary"
          disabled={busy}
          onClick={() => { setCodeView({ kind: "create" }); navigate("code"); mainRef.current?.scrollTo({ top: 0 }); }}
        >
          <AppIcon name="plus" size={16} /> 新建实验
        </button>
        <nav aria-label="投行功能">
          {navigation.map(([id, label]) => (
            <button
              key={id}
              aria-current={(page === id || id === "charts" && marketPages.includes(page) || id === "code" && strategyPages.includes(page)) ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <AppIcon name={pageIcons[id]} size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <details className="investment-nav-group"><summary>研究池 <span>{snapshot?.instruments.length ?? 0}</span><AppIcon name="chevronDown" size={14} /></summary>
        {snapshot?.instruments.map((i) => (
          <button key={i.code} onClick={() => selectInstrument(i.code)}>
            {i.name}
            <small>{i.code}</small>
          </button>
        ))}
        {!snapshot && <p className="investment-nav-empty">等待数据同步</p>}
        </details><details className="investment-nav-group"><summary>ETF 轮动记录 <span>{catalog.reports.length}</span><AppIcon name="chevronDown" size={14} /></summary>
        {catalog.reports.slice(0, 8).map((r) => (
          <button
            key={r.id}
            onClick={() => {
              setReportId(r.id);
              setConfigOpen(false);
              setPage("backtest");
            }}
          >
            {r.spec.flowFilter ? "资金过滤" : "价格动量"} / {r.spec.codes ? `${r.spec.codes.length} 只` : "全池"}
            <small>
              {r.spec.start} → {r.spec.end}
            </small>
          </button>
        ))}
        </details><div className="investment-sidebar-footer"><AppIcon name="shield" size={15} /><span>本地研究 / 无交易执行</span></div>
      </aside>
      <main className="investment-main" ref={mainRef}>
        <header className="investment-between">
          <div className="investment-controls">
            <button
              className="investment-expand"
              aria-label="展开投行导航"
              onClick={() => setCollapsed(false)}
            >
              <AppIcon name="panel" size={18} />
            </button>
            <span className="investment-breadcrumb">投行 <span>/</span></span>
            <strong>{marketPages.includes(page) ? "市场研究" : strategyPages.includes(page) ? "策略实验" : pages.find(([id]) => id === page)?.[1]}</strong>
          </div>
          <div className="investment-controls">
            <button className="investment-assistant-toggle" onClick={() => setAssistantOpen(true)}><AppIcon name="sparkles" size={16} />讨论此页</button>
          {page !== "code" && <button disabled={busy} onClick={() => void start(page === "margin" ? { operation: "marginSync" } : { operation: "sync" })}>
            <AppIcon name="refresh" size={16} />{busy ? "任务处理中" : "同步数据"}
          </button>}
          </div>
        </header>
        {busy && (
          <div className="investment-task" role="status">
            <span>{status?.status === "running" ? status.phase : submitting ? "正在启动任务…" : "正在刷新结果…"}</span>
            <button
              disabled={!jobId || cancelPending || status?.status !== "running"}
              onClick={() => { setCancelPending(true); void investmentCancel(jobId).catch((e) => { setCancelPending(false); setError(String(e)); }); }}
            >
              {cancelPending ? "正在取消…" : "取消任务"}
            </button>
          </div>
        )}
        {error && (
          <div className="investment-error" role="alert">
            <div><strong>任务未完成</strong><p>{error}</p></div>
            <div className="investment-controls">
            {!busy && (lastRequest.current || !snapshot) && <button onClick={() => void start(lastRequest.current ?? { operation: "sync" })}>重试</button>}
            <button onClick={() => setError("")} aria-label="关闭错误提示">
              <AppIcon name="close" size={16} />
            </button>
            </div>
          </div>
        )}
        {status?.status === "cancelled" && (
          <p role="status">任务已取消，已有快照和报告保留。</p>
        )}
        <div className="investment-content">
          {(marketPages.includes(page) || strategyPages.includes(page)) && <nav className="investment-subnav" aria-label="研究视图">{(marketPages.includes(page) ? [["charts","行情"],["flows","ETF 资金"],["margin","两融"]] : [["code","代码策略"],["backtest","ETF 轮动"]]).map(([id,label]) => <button key={id} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>{label}</button>)}</nav>}
          {snapshot && page !== "code" && page !== "margin" && (
            <div className="investment-between investment-snapshot">
              <label>
                研究快照{" "}
                <ResearchSelect label="研究快照" value={snapshot.id} onChange={setSnapshotId}
                  options={catalog.snapshots.map((s, index) => ({ value: s.id,
                    label: `${index === 0 ? "最新 / " : ""}${new Date(s.createdAt).toLocaleString()}`,
                    detail: `${s.instruments.length} 只 ETF / 行情 ${s.instruments[0]?.bars.at(-1)?.date ?? "暂无"} / ${s.id.slice(0, 8)}` }))} />
              </label>
              <span>
                行情截至 {snapshot.instruments[0]?.bars.at(-1)?.date}
              </span>
            </div>
          )}
          {page === "code" ? <CodeLab datasets={catalog.datasets ?? []} reports={catalog.scriptReports ?? []} datasetId={datasetId} reportId={scriptReportId}
            view={codeView} onView={setCodeView}
            example={catalog.strategyRuntime?.example ?? ""} busy={busy} onDataset={setDatasetId} onReport={setScriptReportId}
            onSync={request => void start(request)}
            onRun={spec => void start({ operation: "scriptBacktest", spec })} onContext={setCodeContext} onAsk={() => setAssistantOpen(true)} /> : page === "margin" ? <MarginView snapshots={catalog.marginSnapshots ?? []} selectedId={marginId} busy={busy} onSelect={setMarginId} onSync={() => void start({ operation: "marginSync" })} onContext={setMarginContext} /> : !snapshot ? (
            <ResearchEmpty busy={busy} onSync={() => void start({ operation: "sync" })} onAssistant={() => setAssistantOpen(true)} />
          ) : (
            <>
              {page === "home" && <ResearchOverview snapshot={snapshot} report={report} reportCount={catalog.reports.length} onSelect={selectInstrument} onPage={setPage} onCategory={setOverviewCategory} />}
              {page === "flows" && (
                <FlowView key={`${snapshot.id}:${activityRevision}`} initialDays={flowDays} snapshot={snapshot} onSelect={selectInstrument} onContextChange={setFlowContext} />
              )}
              {page === "charts" && instrument && (
                <>
                  <ResearchSelect label="行情标的" value={instrument.code} onChange={setInstrumentCode}
                    options={snapshot.instruments.map(i => ({ value: i.code, label: i.name, detail: `${i.code} / ${i.category || "未分类"}` }))} />
                  <MarketView
                    instrument={instrument}
                    onBacktest={() => setPage("backtest")}
                  />
                </>
              )}
              {page === "backtest" && (
                <>
                  <h1>策略回测</h1>
                  <details className="investment-config" open={configOpen || !report} onToggle={(event) => setConfigOpen(event.currentTarget.open)}>
                  <summary>配置实验 <span>价格动量 / 交易成本 / 区间</span></summary>
                  <BacktestForm
                    key={snapshot.id}
                    snapshot={snapshot}
                    busy={busy}
                    onDraft={setBacktestDraft}
                    onRun={(spec) =>
                      void start({ operation: "backtest", spec })
                    }
                  />
                  </details>
                  {report && (
                    <>
                      <label className="investment-report-select">
                        查看历史报告
                        <ResearchSelect label="历史报告" value={report.id} onChange={setReportId}
                          options={catalog.reports.map(r => ({ value: r.id, label: `${r.spec.flowFilter ? "资金过滤" : "价格动量"} / ${r.spec.codes ? `${r.spec.codes.length} 只` : "全池"} / ${r.spec.start} → ${r.spec.end}`,
                            detail: `${new Date(r.createdAt).toLocaleString()} / ${r.id.slice(0, 8)}` }))} />
                      </label>

                      <div ref={reportAnchor}><ReportView key={report.id} report={report} /></div>
                    </>
                  )}
                </>
              )}
              {page === "data" && <DataView snapshot={snapshot} />}
            </>
          )}
        </div>
      </main>
    </div>
    <InvestmentAssistant context={context} open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
