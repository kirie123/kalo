import { useState } from "react";
import type { TransferChoice, TransferDetails, TransferItem, TransferPreview as Preview } from "./types";

const statusLabels: Record<string, string> = { new: "新增", same: "相同，跳过", conflict: "内容冲突" };
const kindLabels: Record<string, string> = { memory: "记忆", archive: "归档记忆", note: "笔记", domain: "分类描述", attachment: "附件" };

export default function TransferPreview({ preview, busy, onChoice, onInspect }: {
  preview: Preview; busy: boolean; onChoice: (item: TransferItem, choice: TransferChoice) => void;
  onInspect: (path: string) => Promise<TransferDetails>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [details, setDetails] = useState<{ path: string; value: TransferDetails } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const entries = preview.manifest.entries;
  const size = entries.reduce((n, e) => n + e.bytes, 0);
  const filtered = preview.items.filter((i) => (!onlyConflicts || i.status === "conflict") && i.source.toLowerCase().includes(query.toLowerCase()));
  const inspect = async (path: string) => {
    setLoading(true); setError("");
    try { setDetails({ path, value: await onInspect(path) }); } catch (e) { setError(String(e)); } finally { setLoading(false); }
  };
  return <section className="transfer-card">
    <h2>{preview.mode === "export" ? "导出预览" : "导入预览"}</h2>
    <p>{new Date(preview.manifest.exportedAtMs).toLocaleString()} · {entries.length} 个文件 · {(size / 1024 / 1024).toFixed(2)} MiB</p>
    <div className="transfer-counts">{Object.entries(kindLabels).map(([kind, label]) => <span key={kind}>{label} {entries.filter((e) => e.kind === kind).length}</span>)}</div>
    {preview.manifest.warnings.length > 0 && <details><summary>查看 {preview.manifest.warnings.length} 项范围说明</summary><ul>{preview.manifest.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
    {preview.mode === "import" && <>
      <div className="transfer-counts">{Object.entries(statusLabels).map(([status, label]) => <span key={status}>{label} {preview.items.filter((i) => i.status === status).length}</span>)}</div>
      <p className="text-dim">导入只合并资料，不删除本机其他内容。记忆冲突默认暂存，暂存版本不会进入对话。可查看每条新记忆再确认导入。</p>
      <div className="transfer-actions"><input aria-label="筛选资料路径" placeholder="按路径筛选" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} /><label><input type="checkbox" checked={onlyConflicts} onChange={(e) => { setOnlyConflicts(e.target.checked); setPage(0); }} />只看冲突</label></div>
      <div className="transfer-items">{filtered.slice(page * 30, (page + 1) * 30).map((item) => <div className="transfer-item" key={item.source}>
        <div><strong>{item.source}</strong><small>{statusLabels[item.status]}{item.target !== item.source && ` → ${item.target}`}</small></div>
        {item.kind !== "attachment" && <button disabled={busy || loading} onClick={() => void inspect(item.source)}>查看内容</button>}
        {item.status === "conflict" && <select aria-label={`${item.source} 的冲突处理`} disabled={busy} value={item.choice} onChange={(e) => onChoice(item, e.target.value as TransferChoice)}>
          {item.kind === "memory" && <option value="stage">暂存导入版本</option>}
          {item.kind !== "memory" && item.kind !== "domain" && <option value="keepBoth">保留两份</option>}
          <option value="keepLocal">保留本机，跳过导入</option><option value="replace">使用导入版本</option>
        </select>}
      </div>)}</div>
      <div className="transfer-actions"><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} 页 / {Math.max(1, Math.ceil(filtered.length / 30))} 页</span><button disabled={(page + 1) * 30 >= filtered.length} onClick={() => setPage(page + 1)}>下一页</button></div>
      {error && <p role="alert" className="transfer-error">{error}</p>}
      {details && <div className="transfer-comparison"><div className="transfer-row"><h3>{details.path}</h3><button onClick={() => setDetails(null)}>关闭比较</button></div><div className="transfer-columns">
        <label>本机<textarea readOnly value={details.value.local} /></label><label>导入版本<textarea readOnly value={details.value.incoming} /></label>
      </div></div>}
    </>}
  </section>;
}
