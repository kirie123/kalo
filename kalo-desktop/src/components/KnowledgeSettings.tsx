import { useCallback, useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { deleteKnowledgeCard, listKnowledgeCards } from "../lib/pi-bridge";
import type { KnowledgeCardMeta } from "../types";
import KnowledgeEditModal, { DOMAIN_LABEL, DOMAIN_ORDER } from "./KnowledgeEditModal";
import { Section } from "./SettingsPage";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settings section browsing ~/.kalo/knowledge (search / edit / create / delete). */
export default function KnowledgeSettings() {
  const [cards, setCards] = useState<KnowledgeCardMeta[] | null>(null);
  const [query, setQuery] = useState("");
  /** undefined = closed, null = creating, meta = editing. */
  const [editing, setEditing] = useState<KnowledgeCardMeta | null | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setCards(await listKnowledgeCards());
    } catch (err) {
      chatStore.pushToast(`加载知识库失败：${errText(err)}`, "error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (c: KnowledgeCardMeta) => {
    if (!window.confirm(`确定删除卡片「${c.title || c.relPath}」？该操作不可恢复。`)) return;
    try {
      await deleteKnowledgeCard(c.relPath);
      chatStore.pushToast(`已删除 ${c.title || c.relPath}`, "info");
      void reload();
    } catch (err) {
      chatStore.pushToast(`删除失败：${errText(err)}`, "error");
    }
  };

  // Client-side filter over title / tags / domain (key and Chinese label).
  const q = query.trim().toLowerCase();
  const filtered = (cards ?? []).filter((c) => {
    if (!q) return true;
    const hay = [c.title, c.domain, DOMAIN_LABEL[c.domain] ?? "", c.tags.join(" ")].join(" ").toLowerCase();
    return hay.includes(q);
  });

  // Group by domain, known domains first in DOMAIN_ORDER order.
  const grouped = new Map<string, KnowledgeCardMeta[]>();
  for (const c of filtered) {
    const arr = grouped.get(c.domain) ?? [];
    arr.push(c);
    grouped.set(c.domain, arr);
  }
  const domains = [...grouped.keys()].sort((a, b) => {
    const ia = (DOMAIN_ORDER as readonly string[]).indexOf(a);
    const ib = (DOMAIN_ORDER as readonly string[]).indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  return (
    <Section title="知识库">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索标题 / 标签 / 领域"
        className="mb-3 w-full rounded-md border border-edge bg-base px-3 py-1.5 text-sm outline-none focus:border-dim"
      />

      {cards === null ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : cards.length === 0 ? (
        <p className="mb-2 text-xs text-dim">
          暂无知识卡片。知识库位于 <code className="md-inline-code">~/.kalo/knowledge</code>
          ，用 markdown 卡片沉淀可复用的结论；也可以在对话中直接让 Kalo「存入知识库」，或点击下方"新建卡片"。
        </p>
      ) : filtered.length === 0 ? (
        <p className="mb-2 text-xs text-dim">没有匹配「{query.trim()}」的卡片。</p>
      ) : (
        domains.map((d) => (
          <div key={d} className="mb-3">
            <div className="mb-1.5 text-xs font-medium text-dim">
              {DOMAIN_LABEL[d] ?? d}（{grouped.get(d)!.length}）
            </div>
            <div className="flex flex-col gap-1.5">
              {grouped.get(d)!.map((c) => (
                <div
                  key={c.relPath}
                  onClick={() => setEditing(c)}
                  title="点击编辑"
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-edge bg-base px-3 py-2 hover:border-dim"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{c.title || c.relPath}</span>
                      {c.tags.map((t) => (
                        <span key={t} className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="mono truncate text-[10px] text-dim">{c.relPath}</div>
                  </div>
                  <span className="mono shrink-0 text-[10px] text-dim">{c.date.slice(0, 10)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(c);
                    }}
                    className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <button
        onClick={() => setEditing(null)}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
        新建卡片
      </button>

      <p className="mt-3 text-xs leading-relaxed text-dim">
        卡片按领域分目录保存在 <code className="md-inline-code">~/.kalo/knowledge/</code>
        ，frontmatter 里的 title / domain / tags / date 用于检索；对话中让 agent「存入知识库」也会写入这里。
      </p>

      {editing !== undefined && (
        <KnowledgeEditModal
          card={editing ?? undefined}
          onClose={(saved) => {
            setEditing(undefined);
            if (saved) void reload();
          }}
        />
      )}
    </Section>
  );
}
