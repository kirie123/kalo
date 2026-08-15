import { useEffect, useRef, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { readKnowledgeCard, writeKnowledgeCard } from "../lib/pi-bridge";
import type { KnowledgeCardMeta } from "../types";

/** Knowledge domains, in display order. */
export const DOMAIN_ORDER = ["cards", "training-notes", "investing", "math"] as const;

export const DOMAIN_LABEL: Record<string, string> = {
  cards: "通用",
  "training-notes": "训练",
  investing: "投资",
  math: "数学",
};

interface Props {
  /** Given when editing an existing card; undefined for "new card". */
  card?: KnowledgeCardMeta;
  onClose: (saved: boolean) => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Frontmatter + section skeleton prefilled for a new card. */
function cardTemplate(domain: string, title: string): string {
  return [
    "---",
    `title: ${title}`,
    `domain: ${domain}`,
    "tags: []",
    `date: ${todayLocal()}`,
    "source_session: ",
    "---",
    "",
    "## 背景",
    "",
    "",
    "",
    "## 结论",
    "",
    "",
    "",
    "## 证据",
    "",
    "",
    "",
    "## 反例边界",
    "",
  ].join("\n");
}

/**
 * Editor for one knowledge card. Editing loads the full markdown via
 * read_knowledge_card; creating starts from the frontmatter template.
 * Saved via write_knowledge_card.
 */
export default function KnowledgeEditModal({ card, onClose }: Props) {
  const [domain, setDomain] = useState(card?.domain ?? "cards");
  const [title, setTitle] = useState(card?.title ?? "");
  const [content, setContent] = useState<string | null>(card ? null : cardTemplate("cards", ""));
  const [saving, setSaving] = useState(false);
  /** Once the user types into the body, stop syncing the template. */
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    readKnowledgeCard(card.relPath)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        chatStore.pushToast(`读取卡片失败：${errText(err)}`, "error");
        if (!cancelled) onClose(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.relPath]);

  // New card: keep the template in sync until the body is manually edited.
  useEffect(() => {
    if (!card && !dirtyRef.current) setContent(cardTemplate(domain, title));
  }, [card, domain, title]);

  const save = async () => {
    if (content === null || saving) return;
    if (!title.trim()) {
      chatStore.pushToast("标题不能为空", "warning");
      return;
    }
    if (!content.trim()) {
      chatStore.pushToast("内容不能为空", "warning");
      return;
    }
    setSaving(true);
    try {
      const rel = await writeKnowledgeCard(card?.relPath, domain, title.trim(), content);
      chatStore.pushToast(`知识卡片已保存：${rel}`, "info");
      onClose(true);
    } catch (err) {
      chatStore.pushToast(`保存失败：${errText(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => onClose(false)}>
      <div
        className="flex max-h-[85vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-edge bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold">{card ? "编辑知识卡片" : "新建知识卡片"}</h3>
        {card && (
          <div className="mono mb-3 truncate text-xs text-dim" title={card.path}>
            {card.relPath}
          </div>
        )}

        {content === null ? (
          <div className="py-8 text-center text-sm text-dim">加载中…</div>
        ) : (
          <>
            {!card && (
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="标题（决定文件名，如「深蹲发力要点」）"
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-edge bg-base px-3 py-1.5 text-sm outline-none focus:border-dim"
                />
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="shrink-0 cursor-pointer rounded-md border border-edge bg-transparent px-1.5 py-1.5 text-xs text-dim outline-none hover:text-ink"
                >
                  {DOMAIN_ORDER.map((d) => (
                    <option key={d} value={d}>
                      {DOMAIN_LABEL[d] ?? d}（{d}）
                    </option>
                  ))}
                </select>
              </div>
            )}
            <textarea
              value={content}
              onChange={(e) => {
                dirtyRef.current = true;
                setContent(e.target.value);
              }}
              spellCheck={false}
              className="mono min-h-0 w-full flex-1 resize-none rounded-md border border-edge bg-base p-3 text-xs leading-relaxed outline-none focus:border-dim"
            />
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={content === null || saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
