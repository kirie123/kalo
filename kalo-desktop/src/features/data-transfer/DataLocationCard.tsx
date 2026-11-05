import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { dataLocationCommit, dataLocationPrepare, dataLocationStatus } from "../../lib/pi-bridge";
import { pendingDrafts } from "./drafts";
import type { DataLocationStatus } from "./types";

interface Props {
  maintenance?: boolean;
  disabled?: boolean;
  onPrepared?: () => void;
  run?: (work: () => Promise<void>) => Promise<void>;
}

export default function DataLocationCard({ maintenance = false, disabled = false, onPrepared, run }: Props) {
  const [status, setStatus] = useState<DataLocationStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => setStatus(await dataLocationStatus());
  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, []);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); await refresh(); onPrepared?.(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const choose = () => perform(async () => {
    const path = await open({ directory: true, multiple: false, title: "选择存放 Kalo 数据的文件夹" });
    if (typeof path === "string") setSelected(path);
  });
  const prepare = () => perform(async () => {
    if ((await pendingDrafts()).length) throw new Error("有未保存的笔记草稿，请先保存，或在下方另存恢复笔记后再迁移。");
    await dataLocationPrepare(selected); setSelected("");
  });
  const commit = () => {
    if (!run || !status?.target) return;
    void run(async () => { await dataLocationCommit(); });
  };
  const blocked = busy || disabled;
  return <section className="transfer-card">
    <h2>数据存放位置</h2>
    <p className="break-all">当前目录：{status?.root || "正在读取…"}</p>
    <p className="text-dim">选择一个文件夹，全部数据将迁移到它下面的 .kalo，包括聊天记录、附件、配置和工作区。</p>
    {error && <p role="alert" className="transfer-error">{error}</p>}
    {status?.backup && <p className="break-all">上次迁移的备份：{status.backup}。确认新位置工作正常后可手动清理此备份；请保留原位置的兼容入口。</p>}
    <div className="transfer-actions">
      <button disabled={blocked || !status} onClick={() => void choose()}>选择文件夹</button>
      {selected && <button disabled={blocked} onClick={() => void prepare()}>准备迁移到此位置</button>}
    </div>
    {selected && <p className="break-all">将迁移到：{selected.replace(/[\\/]+$/, "")}/.kalo</p>}
    {status?.target && <div role="status">
      <p className="break-all">待迁移到：{status.target}</p>
      <p>{maintenance ? "迁移时请勿关闭窗口；校验完成后自动重启，原数据保留为备份。" : "请结束运行中的任务并正常退出 Kalo，重新打开后确认执行迁移。"}</p>
      <div className="transfer-actions">
        {maintenance && <button disabled={blocked} onClick={commit}>开始迁移并重启</button>}
        <button disabled={blocked} onClick={() => void perform(async () => { await dataLocationPrepare(null); })}>取消目录迁移</button>
      </div>
    </div>}
  </section>;
}
