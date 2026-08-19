/**
 * 知识笔记 panel: domains tree | note list | editor.
 *
 * Everything is derived from one `listKnowledgeCards()` load plus one
 * `listKnowledgeDomains()` load — the filesystem is the state, so a reload
 * after any write is both correct and cheap enough at personal-library scale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatStore } from "../../lib/chat-store";
import { loadWidth, startColumnDrag } from "../../lib/drag";
import {
  deleteKnowledgeCard,
  listKnowledgeCards,
  listKnowledgeDomains,
  readKnowledgeCard,
  searchKnowledge,
  writeKnowledgeCard,
} from "../../lib/pi-bridge";
import type { KnowledgeCardMeta, KnowledgeDomain, KnowledgeSearchHit } from "../../types";
import DomainTree, { filterCards, type NoteFilter } from "./DomainTree";
import NoteEditor from "./NoteEditor";
import NoteList from "./NoteList";
import { errText, noteTemplate } from "./template";

const TREE_W_KEY = "kalo.layout.notesTreeW";
const LIST_W_KEY = "kalo.layout.notesListW";
const SEARCH_DEBOUNCE_MS = 180;

export default function NotesPanel() {
  const [cards, setCards] = useState<KnowledgeCardMeta[]>([]);
  const [domains, setDomains] = useState<KnowledgeDomain[]>([]);
  const [filter, setFilter] = useState<NoteFilter>({ kind: "all" });

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  /** Last saved/loaded text; `dirty` is a comparison, not a flag to maintain. */
  const [baseText, setBaseText] = useState("");
  const [loadingNote, setLoadingNote] = useState(false);
  const [saving, setSaving] = useState(false);

  const [treeW, setTreeW] = useState(() => loadWidth(TREE_W_KEY, 180));
  const [listW, setListW] = useState(() => loadWidth(LIST_W_KEY, 280));

  const reload = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([listKnowledgeCards(), listKnowledgeDomains()]);
      setCards(c);
      setDomains(d);
    } catch (err) {
      chatStore.pushToast(`加载知识库失败：${errText(err)}`, "error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Debounced full-text search. The token guards which response is allowed to
  // land: without it a slow early query can overwrite a newer one's hits.
  const searchToken = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      return;
    }
    const token = ++searchToken.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await searchKnowledge(q);
        if (searchToken.current === token) setHits(found);
      } catch (err) {
        if (searchToken.current === token) chatStore.pushToast(`搜索失败：${errText(err)}`, "error");
      } finally {
        if (searchToken.current === token) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const openNote = useCallback(
    async (relPath: string) => {
      if (relPath === selected) return;
      if (text !== baseText && !window.confirm("当前笔记有未保存的修改，确定放弃？")) return;
      setSelected(relPath);
      setLoadingNote(true);
      try {
        const body = await readKnowledgeCard(relPath);
        setText(body);
        setBaseText(body);
      } catch (err) {
        chatStore.pushToast(`读取失败：${errText(err)}`, "error");
        setSelected(null);
      } finally {
        setLoadingNote(false);
      }
    },
    [selected, text, baseText],
  );

  const save = useCallback(async () => {
    if (!selected || text === baseText) return;
    const card = cards.find((c) => c.relPath === selected);
    setSaving(true);
    try {
      // domain/title only matter when creating; on overwrite the backend keeps
      // the path and the frontmatter in `text` is authoritative.
      await writeKnowledgeCard(selected, card?.domain ?? "cards", card?.title ?? "", text);
      setBaseText(text);
      chatStore.pushToast("已保存", "info");
      void reload();
    } catch (err) {
      chatStore.pushToast(`保存失败：${errText(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }, [selected, text, baseText, cards, reload]);

  const remove = useCallback(async () => {
    if (!selected) return;
    const card = cards.find((c) => c.relPath === selected);
    if (!window.confirm(`确定删除「${card?.title || selected}」？副本会留在 .trash/。`)) return;
    try {
      await deleteKnowledgeCard(selected);
      setSelected(null);
      setText("");
      setBaseText("");
      void reload();
    } catch (err) {
      chatStore.pushToast(`删除失败：${errText(err)}`, "error");
    }
  }, [selected, cards, reload]);

  const create = useCallback(async () => {
    const title = window.prompt("新笔记标题")?.trim();
    if (!title) return;
    // Create into the domain you are looking at; the cross-cutting views
    // (全部 / 待审阅 / 标签) have no obvious home, so those fall back to cards.
    const domain = filter.kind === "domain" ? filter.key : "cards";
    try {
      const relPath = await writeKnowledgeCard(undefined, domain, title, noteTemplate(domain, title));
      await reload();
      setSelected(relPath);
      const body = await readKnowledgeCard(relPath);
      setText(body);
      setBaseText(body);
      setQuery("");
    } catch (err) {
      chatStore.pushToast(`新建失败：${errText(err)}`, "error");
    }
  }, [filter, reload]);

  const visible = useMemo(() => filterCards(cards, filter), [cards, filter]);
  const selectedCard = selected ? cards.find((c) => c.relPath === selected) : undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <div style={{ width: treeW }} className="flex min-h-0 shrink-0 flex-col border-r border-edge">
        <DomainTree
          domains={domains}
          cards={cards}
          filter={filter}
          onSelect={(f) => {
            setFilter(f);
            setQuery("");
          }}
        />
      </div>
      <Splitter onMouseDown={(e) => startColumnDrag(e, treeW, { min: 140, max: 320, persistKey: TREE_W_KEY }, setTreeW)} />

      <div style={{ width: listW }} className="flex min-h-0 shrink-0 flex-col border-r border-edge">
        <NoteList
          cards={visible}
          hits={hits}
          query={query}
          onQueryChange={setQuery}
          searching={searching}
          selected={selected}
          onSelect={(rel) => void openNote(rel)}
          onCreate={() => void create()}
        />
      </div>
      <Splitter onMouseDown={(e) => startColumnDrag(e, listW, { min: 200, max: 480, persistKey: LIST_W_KEY }, setListW)} />

      {selected ? (
        <NoteEditor
          relPath={selected}
          absPath={selectedCard?.path ?? ""}
          text={text}
          loading={loadingNote}
          dirty={text !== baseText}
          saving={saving}
          onChange={setText}
          onSave={() => void save()}
          onDelete={() => void remove()}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs leading-relaxed text-dim">
          选择左侧笔记查看，或新建一条。
          <br />
          笔记保存在 <code className="md-inline-code">~/.kalo/knowledge/</code>，Kalo 也会在对话与定时任务中写入这里。
        </div>
      )}
    </div>
  );
}

function Splitter({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--edge)]"
      role="separator"
      aria-orientation="vertical"
    />
  );
}
