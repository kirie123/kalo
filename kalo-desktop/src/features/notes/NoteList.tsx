/**
 * Middle column: the note list.
 *
 * Two modes share one column. With an empty search box it lists the current
 * filter's cards (client-side, from the already-loaded metadata). With a query
 * it shows backend full-text hits instead — those are line-level, so the row
 * shape differs: one row per file with its matching lines beneath.
 */

import type { KnowledgeCardMeta, KnowledgeSearchHit } from "../../types";
import { STATUS_LABEL } from "./template";

export default function NoteList({
  cards,
  hits,
  query,
  onQueryChange,
  searching,
  selected,
  onSelect,
  onCreate,
}: {
  /** Already filtered by the tree; used when `query` is empty. */
  cards: KnowledgeCardMeta[];
  /** Backend hits; used when `query` is non-empty. */
  hits: KnowledgeSearchHit[];
  query: string;
  onQueryChange: (q: string) => void;
  searching: boolean;
  selected: string | null;
  onSelect: (relPath: string) => void;
  onCreate: () => void;
}) {
  const searchMode = query.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-edge p-2">
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="全文搜索…"
          className="min-w-0 flex-1 rounded-md border border-edge bg-base px-2.5 py-1.5 text-sm outline-none focus:border-dim"
        />
        <button
          onClick={onCreate}
          title="新建笔记"
          className="shrink-0 rounded-md border border-edge px-2 py-1.5 text-dim hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {searchMode ? (
          searching && hits.length === 0 ? (
            <Empty text="搜索中…" />
          ) : hits.length === 0 ? (
            <Empty text={`没有匹配「${query.trim()}」的内容。`} />
          ) : (
            groupHits(hits).map(([relPath, group]) => (
              <button
                key={relPath}
                onClick={() => onSelect(relPath)}
                className={`block w-full border-b border-edge px-3 py-2 text-left hover:bg-card ${
                  selected === relPath ? "bg-card" : ""
                }`}
              >
                <div className="truncate text-sm text-ink">{group[0].title || relPath}</div>
                {group.map((h) => (
                  <div key={h.line} className="mono mt-1 flex gap-1.5 text-[10px] leading-relaxed text-dim">
                    <span className="shrink-0">{h.line}</span>
                    <span className="min-w-0 flex-1 truncate">{h.snippet}</span>
                  </div>
                ))}
              </button>
            ))
          )
        ) : cards.length === 0 ? (
          <Empty text="这里还没有笔记。点右上角 + 新建，或让 Kalo 在对话里存入知识库。" />
        ) : (
          cards.map((c) => (
            <button
              key={c.relPath}
              onClick={() => onSelect(c.relPath)}
              className={`block w-full border-b border-edge px-3 py-2 text-left hover:bg-card ${
                selected === c.relPath ? "bg-card" : ""
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.title || c.relPath}</span>
                {c.reviewed === false && (
                  <span className="shrink-0 rounded border border-[var(--accent)] px-1 py-px text-[10px] text-accent">
                    待审
                  </span>
                )}
                <span className="mono shrink-0 text-[10px] text-dim">{(c.updated || c.date).slice(0, 10)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">{c.domain}</span>
                {c.status && (
                  <span className="shrink-0 text-[10px] text-dim">{STATUS_LABEL[c.status] ?? c.status}</span>
                )}
                {c.tags.slice(0, 3).map((t) => (
                  <span key={t} className="shrink-0 text-[10px] text-dim">
                    #{t}
                  </span>
                ))}
              </div>
              {c.snippet && <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-dim">{c.snippet}</div>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Hits arrive flat (already capped per file by the backend); collapse them
 * back into one row per file, preserving the backend's file order.
 */
function groupHits(hits: KnowledgeSearchHit[]): [string, KnowledgeSearchHit[]][] {
  const map = new Map<string, KnowledgeSearchHit[]>();
  for (const h of hits) {
    const arr = map.get(h.relPath);
    if (arr) arr.push(h);
    else map.set(h.relPath, [h]);
  }
  return [...map.entries()];
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-4 text-xs leading-relaxed text-dim">{text}</p>;
}
