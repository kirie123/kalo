import { useEffect, useRef, useState } from "react";
import { chatStore, useChatSelector } from "../../lib/chat-store";
import { filterExperts, type ExpertKindFilter } from "../../lib/expert-catalog";
import { selectChatExpert } from "../../lib/expert-selection";
import { expertList } from "../../lib/pi-bridge";
import type { Expert } from "../../types";

/** Role selection sits beside cwd selection; choosing one does not replace the other. */
export default function ExpertPicker() {
  const { expertId, busy } = useChatSelector((s) => ({ expertId: s.expertId, busy: s.isStreaming || s.isCompacting || s.connecting }));
  const [experts, setExperts] = useState<Expert[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ExpertKindFilter>("all");
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    expertList().then((list) => { if (alive) { setExperts(list); setError(""); } })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [open, expertId]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const choose = async (expert: Expert | null) => {
    setSelecting(true);
    try {
      await selectChatExpert(expert, experts);
      setOpen(false);
    } catch (e) {
      chatStore.pushToast(`选择专家失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setSelecting(false); }
  };
  const selected = experts.find((expert) => expert.id === expertId);
  const matches = filterExperts(experts.filter((expert) => expert.enabled), query, kind);

  return (
    <div ref={root} className="relative min-w-0">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} disabled={busy || selecting}
        onClick={() => setOpen((value) => !value)}
        title="选择专家或专家团，工作目录单独选择；已有对话切换专家会开启新对话"
        className="flex max-w-48 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-dim hover:bg-card hover:text-ink disabled:opacity-50">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><circle cx="8" cy="5" r="2.5" /><path d="M3 14v-1a5 5 0 0110 0v1M12 3l1 1 2-2" /></svg>
        <span className="truncate">{selected?.name ?? (expertId ? "所选专家" : "选择专家")}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div role="dialog" aria-label="选择专家" className="absolute bottom-full left-0 z-40 mb-2 w-80 rounded-xl border border-edge bg-elevated p-2 shadow-lift">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索专家、专家团或专长"
            aria-label="搜索专家" className="w-full rounded-lg border border-edge bg-base px-2.5 py-2 text-xs outline-none focus:border-dim" />
          <div className="my-2 flex gap-1">
            {([['all', '全部'], ['agent', '专家'], ['team', '专家团']] as const).map(([value, label]) => (
              <button key={value} onClick={() => setKind(value)} aria-pressed={kind === value}
                className={`rounded px-2 py-1 text-xs ${kind === value ? "bg-card text-ink" : "text-dim hover:bg-card"}`}>{label}</button>
            ))}
          </div>
          <div className="max-h-72 overflow-y-auto">
            <button disabled={selecting} onClick={() => void choose(null)} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs hover:bg-card">
              <span>通用助手</span>{!expertId && <span className="text-dim">已选择</span>}
            </button>
            {matches.map((expert) => (
              <button key={expert.id} disabled={selecting} onClick={() => void choose(expert)}
                className="flex w-full flex-col gap-1 rounded-lg px-2 py-2 text-left hover:bg-card">
                <span className="flex w-full items-center gap-2 text-xs"><span className="font-medium">{expert.name}</span>
                  <span className="text-[10px] text-dim">{expert.kind === "team" ? "专家团" : "专家"}</span>
                  {expertId === expert.id && <span className="ml-auto text-[10px] text-dim">已选择</span>}</span>
                <span className="line-clamp-2 text-[11px] leading-relaxed text-dim">{expert.mission}</span>
              </button>
            ))}
            {!matches.length && <p className="px-2 py-3 text-xs text-dim">{error ? `加载失败：${error}` : "没有匹配的专家。可在侧边栏「专家市场」导入或新建。"}</p>}
          </div>
          <p className="mt-1 border-t border-edge px-2 pt-2 text-[10px] text-dim">角色与工作目录独立；任务产出保存在所选工作目录。</p>
        </div>
      )}
    </div>
  );
}
