import { useState } from "react";
import type { EraTree } from "./types";
import { acceptanceLabel } from "./acceptance";

export default function EraAcceptance({ tree, onOpen }: { tree: EraTree; onOpen: () => Promise<void> }) {
  const [error, setError] = useState("");
  const finals = tree.acceptanceStages.filter((s) => s.scope === "final");
  const shown = (finals.length ? finals : tree.acceptanceStages).slice(-8);
  return (
    <section className="rounded-lg border border-edge bg-card p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">{acceptanceLabel(tree.acceptanceStatus)}</span>
        {tree.contractName && <span className="text-dim">{tree.contractName}</span>}
        {tree.accepted && <button className="ml-auto text-[var(--ok)] hover:underline" onClick={() => {
          setError("");
          void onOpen().catch((e: unknown) => setError(String(e)));
        }}>打开已验收产物</button>}
      </div>
      <p className="mt-1 text-dim">搜索最好分数不代表已通过完整验收。</p>
      {tree.acceptanceReason && <p className="mt-1 text-[var(--warn)]">{tree.acceptanceReason}</p>}
      {shown.map((s, i) => <div key={`${s.nodeId}-${s.stage}-${i}`} className="mt-2">
        <span>{s.scope === "final" ? "最终验收" : "快速检查"} · {s.stage} · {s.status}</span>
        {s.reason && <p className="text-dim">{s.reason}</p>}
      </div>)}
      {error && <p role="alert" className="mt-2 text-[var(--danger)]">无法打开产物：{error}</p>}
    </section>
  );
}
