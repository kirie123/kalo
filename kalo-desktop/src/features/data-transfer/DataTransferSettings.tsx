import { useEffect, useState } from "react";
import { dataTransferArm, dataTransferStatus } from "../../lib/pi-bridge";
import { pendingDrafts, preserveDraft, type PendingDraft } from "./drafts";

export default function DataTransferSettings() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void dataTransferStatus().then((s) => setArmed(s.armed)).catch((e) => setError(String(e))); }, []);

  const prepare = async () => {
    setBusy(true); setError("");
    try {
      if (armed) { await dataTransferArm(false); setArmed(false); return; }
      const remaining = await pendingDrafts(); setDrafts(remaining);
      if (remaining.length) return;
      await dataTransferArm(true); setArmed(true);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const recover = async (draft: PendingDraft) => {
    setBusy(true); setError("");
    try { await preserveDraft(draft); setDrafts(await pendingDrafts()); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return <section className="transfer-panel">
    <p>把个人记忆、笔记、分类和引用附件导出为一个资料包，再导入另一台 Windows 或 macOS 设备。</p>
    <p className="text-dim">迁移需要独立的数据管理窗口，期间不启动对话引擎、网关和后台任务。请同时暂停外部编辑器或同步软件对这些文件的修改。</p>
    {error && <p role="alert" className="transfer-error">{error}</p>}
    {drafts.length > 0 && <div className="transfer-card">
      <h3>先保留未保存草稿</h3><p>以下草稿尚未写入磁盘。可以返回笔记页恢复，或另存为恢复笔记后继续。</p>
      {drafts.map((d) => <div key={d.path} className="transfer-row"><span>{d.path}</span><button disabled={busy} onClick={() => void recover(d)}>另存恢复笔记</button></div>)}
    </div>}
    {armed && <p role="status" className="transfer-card">已准备好。请结束正在运行的任务并正常退出 Kalo，再次打开后会进入数据管理窗口。当前任务不会被自动终止。</p>}
    <button disabled={busy} onClick={() => void prepare()}>{busy ? "正在处理…" : armed ? "取消下次启动进入数据管理" : "准备迁移（下次启动）"}</button>
    <p className="text-dim">资料包不包含聊天记录、API Key 配置、专家记忆或回收站。首版为明文 ZIP，请妥善保管。</p>
  </section>;
}
