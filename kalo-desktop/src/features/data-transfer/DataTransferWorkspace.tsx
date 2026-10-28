import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import TitleBar from "../../components/TitleBar";
import { applyAppearance, loadSkin, loadTheme } from "../appearance/preferences";
import {
  cancelDataTransfer, commitDataImport, dataTransferDetails, dataTransferLeave, dataTransferRecover,
  dataTransferStatus, finishDataExport, listDataTransfers, onDataTransferProgress, prepareDataExport,
  prepareDataImport, resolveDataImport, undoDataImport,
} from "../../lib/pi-bridge";
import TransferPreviewView from "./TransferPreview";
import type { TransferChoice, TransferItem, TransferJournal, TransferPreview, TransferProgress, TransferStatus } from "./types";

const states: Record<string, string> = { committed: "已完成", undone: "已撤销", rolledBack: "已回滚", prepared: "准备中", applying: "写入中", undoing: "撤销中" };

export default function DataTransferWorkspace({ initialStatus }: { initialStatus: TransferStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [memory, setMemory] = useState(true);
  const [notes, setNotes] = useState(true);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [history, setHistory] = useState<TransferJournal[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [hasDrafts] = useState(() => {
    try { return Object.keys(localStorage).some((k) => k.startsWith("kalo.notes.draft.")); }
    catch { return true; }
  });
  const refresh = useCallback(async () => {
    const current = await dataTransferStatus(); setStatus(current);
    if (!current.recoveryError) setHistory((await listDataTransfers()).reverse());
  }, []);
  useEffect(() => {
    applyAppearance(loadTheme(), loadSkin());
    void refresh().catch((e) => setError(String(e)));
    const off = onDataTransferProgress(setProgress);
    return () => { void off.then((fn) => fn()).catch(() => {}); };
  }, [refresh]);
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setMessage(""); setProgress(null);
    try { await work(); }
    catch (e) { setError(String(e)); }
    finally {
      try { await refresh(); } catch (e) { setError((old) => old || String(e)); }
      busyRef.current = false; setBusy(false); setProgress(null);
    }
  };
  const exportData = () => run(async () => { setPreview(await prepareDataExport({ memory, notes })); });
  const importData = () => run(async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Kalo 个人资料包", extensions: ["zip"] }] });
    if (typeof path === "string") setPreview(await prepareDataImport(path));
  });
  const choose = (item: TransferItem, choice: TransferChoice) => void run(async () => {
    if (!preview) return;
    const decisions = preview.items.filter((i) => i.status === "conflict").map((i) => ({ path: i.source, choice: i.source === item.source ? choice : i.choice }));
    setPreview(await resolveDataImport(preview.operationId, decisions));
  });
  const confirm = () => run(async () => {
    if (!preview) return;
    if (preview.mode === "export") {
      const path = await save({ defaultPath: `Kalo-${new Date().toISOString().slice(0, 10)}.kalo-data.zip`, filters: [{ name: "Kalo 个人资料包", extensions: ["zip"] }] });
      if (!path) return;
      await finishDataExport(preview.operationId, path);
      setMessage(`已导出 ${preview.manifest.entries.length} 个文件：${path}`);
    } else {
      const result = await commitDataImport(preview.operationId, preview.revision);
      const written = result.items.filter((i) => i.status !== "same" && i.choice !== "keepLocal");
      const staged = written.filter((i) => i.choice === "stage").length;
      setMessage(`导入完成：写入 ${written.length} 个文件（含暂存记忆 ${staged} 条），跳过 ${result.items.length - written.length} 个。返回 Kalo 后生效。`);
    }
    setPreview(null);
  });
  const cancel = () => run(async () => { if (preview) await cancelDataTransfer(preview.operationId); setPreview(null); });
  const undo = (journal: TransferJournal) => {
    if (!window.confirm("撤销这次导入？将恢复被替换的原文件，并移除本次新增内容；若之后被修改则停止。共享附件会保留。")) return;
    void run(async () => { await undoDataImport(journal.id); setMessage("已撤销本次导入，共享附件保留。"); });
  };
  const blocked = busy || hasDrafts || Boolean(status.recoveryError);

  return <div className="transfer-workspace">
    <TitleBar title="数据管理 · 维护模式" />
    <main className="transfer-main transfer-panel">
      <div className="transfer-row"><div><h1>带走你的记忆与笔记</h1><p className="text-dim">当前不运行对话引擎和后台任务。请暂停其他程序对个人资料的修改。</p></div>
        <button disabled={busy || !!status.recoveryError} onClick={() => void run(async () => { if (preview) await cancelDataTransfer(preview.operationId); await dataTransferLeave(); })}>返回 Kalo（重启）</button>
      </div>
      {hasDrafts && <p role="alert" className="transfer-error">仍有未保存的笔记草稿。请返回 Kalo，在笔记页恢复保存，或在数据管理设置中另存恢复笔记，再进入维护模式。</p>}
      {status.recoveryError && <div role="alert" className="transfer-card"><h2>上次迁移需要恢复</h2><p>{status.recoveryError}</p><p>备份仍保存在个人数据目录的 transfers/history 中。处理提示中的文件冲突后，可重试恢复。</p><button disabled={busy} onClick={() => void run(async () => { await dataTransferRecover(); setMessage("恢复完成，可以继续迁移。"); })}>重试恢复</button></div>}
      {error && <p role="alert" className="transfer-error">{error}</p>}
      {message && <p role="status" className="transfer-card">{message}</p>}
      {busy && <div role="status" aria-live="polite" className="transfer-progress"><span>{progress?.phase || "正在处理，请勿关闭窗口…"}</span>{progress && <><progress max={Math.max(1, progress.total)} value={progress.completed} /><span>{progress.completed} / {progress.total}</span></>}</div>}
      {!preview && <div className="transfer-columns">
        <section className="transfer-card"><h2>导出资料包</h2><p>包含引用的本地附件，图片路径会转换为可跨设备使用的相对路径。</p>
          <div className="transfer-actions"><label><input type="checkbox" checked={memory} disabled={busy} onChange={(e) => setMemory(e.target.checked)} />个人记忆</label><label><input type="checkbox" checked={notes} disabled={busy} onChange={(e) => setNotes(e.target.checked)} />全部笔记与分类</label></div>
          <button disabled={blocked || (!memory && !notes)} onClick={() => void exportData()}>扫描并预览导出</button>
        </section>
        <section className="transfer-card"><h2>导入资料包</h2><p>先校验内容并预览冲突，确认后合并到本机。不会删除包中没有的本机资料。</p><button disabled={blocked} onClick={() => void importData()}>选择资料包</button></section>
      </div>}
      <p className="text-dim">资料包为明文 ZIP，不含聊天记录、认证配置、专家记忆、回收站和历史备份。网页图片仍需联网；缺失附件和外部文件引用需修复后重试。</p>
      {preview && <><TransferPreviewView key={preview.operationId} preview={preview} busy={busy} onChoice={choose} onInspect={(path) => dataTransferDetails(preview.operationId, path)} />
        <div className="transfer-actions"><button disabled={blocked} onClick={() => void confirm()}>{preview.mode === "export" ? "选择位置并导出" : "确认导入"}</button>
          {preview.mode === "import" && <button disabled={busy} onClick={() => void run(async () => { setPreview(await resolveDataImport(preview.operationId, preview.items.filter((i) => i.status === "conflict").map((i) => ({ path: i.source, choice: i.choice })))); })}>重新检查预览</button>}
          <button disabled={busy} onClick={() => void cancel()}>取消预览</button></div></>}
      <section className="transfer-card"><h2>迁移记录</h2>{history.length === 0 && <p className="text-dim">还没有导入记录。</p>}
        {history.slice(0, 30).map((j) => <details key={j.id}><summary>{new Date(j.createdAtMs).toLocaleString()} · {states[j.state] || j.state} · {j.items.length} 个文件</summary>
          <p className="text-dim">备份：transfers/history/{j.id}</p>
          {j.items.filter((i) => i.choice === "stage").map((i) => <p key={i.source}>待处理记忆：{i.target}</p>)}
          <p>暂存记忆可在文件管理器中查看；确认内容后再通过记忆设置编辑生效。</p>
          <button disabled={blocked || !!preview || j.state !== "committed"} onClick={() => undo(j)}>撤销本次导入</button>
        </details>)}
      </section>
    </main>
  </div>;
}
