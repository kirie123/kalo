import { useCallback, useEffect, useRef, useState } from "react";
import {
  investmentCancel,
  investmentCatalog,
  investmentStart,
  investmentStatus,
  investmentActivity,
} from "../../lib/pi-bridge";
import type { Catalog, JobStatus, Request } from "./types";
import { BacktestForm, ReportView } from "./Backtest";
import { DataView, FlowView, MarketView } from "./DataViews";
import "./investment.css";
import "./research.css";
import "./controls.css";
import { ResearchSelect } from "./ResearchSelect";
import InvestmentAssistant from "./InvestmentAssistant";
import AppIcon, { type IconName } from "../../components/AppIcon";
import ResearchOverview, { ResearchEmpty } from "./ResearchOverview";
const pageIcons: Record<string, IconName> = { home: "panel", flows: "chart", charts: "chart", backtest: "checklist", data: "plug" };
const pages = [
  ["home", "决策台"],
  ["flows", "ETF 资金"],
  ["charts", "行情研究"],
  ["backtest", "策略回测"],
  ["data", "数据中心"],
];
export default function InvestmentPanel() {
  const [page, setPage] = useState("home");
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
  const [assistantOpen, setAssistantOpen] = useState(false);
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
          await refresh();
          if (stopped) return;
          activitySeen.current = focus.revision;
          setActivityRevision(focus.revision);
          if (activity.job && !activity.job.error) setError("");
          if (activity.job?.status !== "running") setCancelPending(false);
          if (focus.snapshotId) setSnapshotId(focus.snapshotId);
          if (focus.reportId) { setReportId(focus.reportId); setConfigOpen(false); }
          if (focus.days) setFlowDays(focus.days);
          if (pages.some(([id]) => id === focus.page)) setPage(focus.page);
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
  }, [refresh]);
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
        localStorage.removeItem("kalo.investment.job");
        setJobId("");
        if (next.error) setError(next.error);
        await refresh();
        if (next.result && "instruments" in next.result)
          setSnapshotId(next.result.id);
        if (next.result && "spec" in next.result) {
          setReportId(next.result.id);
          setConfigOpen(false);
          setPage("backtest");
        }
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
  }, [jobId, refresh]);
  const start = async (request: Request) => {
    if (busy) return;
    lastRequest.current = request;
    setCancelPending(false);
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
    setPage("charts");
  };
  return (
    <div className="investment-shell">
    <div className={`investment ${collapsed ? "investment-collapsed" : ""}`}>
      <aside className="investment-sidebar">
        <div className="investment-between">
          <h1>投行</h1>
          <button aria-label="收起投行导航" onClick={() => setCollapsed(true)}>
            ‹
          </button>
        </div>
        <button
          className="investment-primary"
          onClick={() => { setPage("backtest"); setConfigOpen(true); }}
        >
          <AppIcon name="plus" size={16} /> 新建实验
        </button>
        <nav aria-label="投行功能">
          {pages.map(([id, label]) => (
            <button
              key={id}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <AppIcon name={pageIcons[id]} size={17} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <h3>研究池</h3>
        {snapshot?.instruments.map((i) => (
          <button key={i.code} onClick={() => selectInstrument(i.code)}>
            {i.name}
            <small>{i.code}</small>
          </button>
        ))}
        {!snapshot && <p className="investment-nav-empty">等待数据同步</p>}
        <h3>历史实验</h3>
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
        <div className="investment-sidebar-footer"><AppIcon name="shield" size={15} /><span>本地研究 / 无交易执行</span></div>
      </aside>
      <main className="investment-main" ref={mainRef}>
        <header className="investment-between">
          <div className="investment-controls">
            <button
              className="investment-expand"
              aria-label="展开投行导航"
              onClick={() => setCollapsed(false)}
            >
              ☰
            </button>
            <span className="investment-breadcrumb">投行 <span>/</span></span>
            <strong>{pages.find(([id]) => id === page)?.[1]}</strong>
          </div>
          <div className="investment-controls">
            <button className="investment-assistant-toggle" aria-expanded={assistantOpen} onClick={() => setAssistantOpen((open) => !open)}><AppIcon name="model" size={16} />研究助手</button>
          <button
            disabled={busy}
            onClick={() => void start({ operation: "sync" })}
          >
            <AppIcon name="plug" size={16} />{busy ? "任务处理中" : "同步数据"}
          </button>
          </div>
        </header>
        {busy && (
          <div className="investment-task" role="status">
            <span>{status?.phase ?? "正在启动任务…"}</span>
            <button
              disabled={!jobId || cancelPending}
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
              ×
            </button>
            </div>
          </div>
        )}
        {status?.status === "cancelled" && (
          <p role="status">任务已取消，已有快照和报告保留。</p>
        )}
        <div className="investment-content">
          {snapshot && (
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
          {!snapshot ? (
            <ResearchEmpty busy={busy} onSync={() => void start({ operation: "sync" })} onAssistant={() => setAssistantOpen(true)} />
          ) : (
            <>
              {page === "home" && <ResearchOverview snapshot={snapshot} report={report} reportCount={catalog.reports.length} onSelect={selectInstrument} onPage={setPage} />}
              {page === "flows" && (
                <FlowView key={`${snapshot.id}:${activityRevision}`} initialDays={flowDays} snapshot={snapshot} onSelect={selectInstrument} />
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
    {assistantOpen && <InvestmentAssistant snapshotId={snapshot?.id} onClose={() => setAssistantOpen(false)} />}
    </div>
  );
}
