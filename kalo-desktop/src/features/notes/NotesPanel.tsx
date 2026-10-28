import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppIcon from "../../components/AppIcon";
import { chatStore } from "../../lib/chat-store";
import { loadWidth, startColumnDrag } from "../../lib/drag";
import { listKnowledgeCards, listKnowledgeDomains, searchKnowledge } from "../../lib/pi-bridge";
import type { KnowledgeCardMeta, KnowledgeDomain, KnowledgeSearchHit } from "../../types";
import DomainTree, { filterCards, type NoteFilter } from "./DomainTree";
import NoteEditor from "./NoteEditor";
import NoteList from "./NoteList";
import { noteTitle } from "./document";
import { errText } from "./template";
import { useNoteDocument } from "./useNoteDocument";

const TREE_W_KEY = "kalo.layout.notesTreeW";
const LIST_W_KEY = "kalo.layout.notesListW";

export default function NotesPanel({ onDataTransfer }: { onDataTransfer?: () => void }) {
  const [cards, setCards] = useState<KnowledgeCardMeta[]>([]);
  const [domains, setDomains] = useState<KnowledgeDomain[]>([]);
  const [filter, setFilter] = useState<NoteFilter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeW, setTreeW] = useState(() => Math.min(260, Math.max(170, loadWidth(TREE_W_KEY, 205))));
  const [listW, setListW] = useState(() => Math.min(350, Math.max(210, loadWidth(LIST_W_KEY, 260))));
  const reloadToken = useRef(0);
  const reload = useCallback(async () => {
    const token = ++reloadToken.current;
    try {
      const [c, d] = await Promise.all([listKnowledgeCards(), listKnowledgeDomains()]);
      if (token !== reloadToken.current) return;
      setCards(c.sort((a, b) => (b.updated || b.date).localeCompare(a.updated || a.date)));
      setDomains(d);
    } catch (err) { chatStore.pushToast(`加载笔记失败：${errText(err)}`, "error"); }
  }, []);
  const doc = useNoteDocument(reload);

  useEffect(() => {
    void reload();
    return () => { reloadToken.current++; };
  }, [reload]);

  const searchToken = useRef(0);
  useEffect(() => {
    const token = ++searchToken.current;
    const q = query.trim();
    setHits([]);
    setSearching(Boolean(q));
    if (!q) return;
    const timer = setTimeout(async () => {
      try {
        const result = await searchKnowledge(q);
        if (searchToken.current === token) setHits(result);
      } catch (err) {
        if (searchToken.current === token) chatStore.pushToast(`搜索失败：${errText(err)}`, "error");
      } finally { if (searchToken.current === token) setSearching(false); }
    }, 180);
    return () => { clearTimeout(timer); searchToken.current++; };
  }, [query]);

  const create = async () => {
    const domain = filter.kind === "domain" ? filter.key : "cards";
    if (await doc.create(domain)) { setQuery(""); setFilter({ kind: "domain", key: domain }); }
  };
  const visible = useMemo(() => filterCards(cards, filter), [cards, filter]);
  const selectedCard = cards.find((c) => c.relPath === doc.selected);
  const rows = visible.map((card) => card.relPath === doc.selected ? { ...card, title: noteTitle(doc.text, card.title) } : card);

  return <div className="notes-workspace">
    <aside className={`notes-tree ${treeOpen ? "notes-tree-open" : ""}`} style={{ width: treeW }}>
      <div className="sidebar-heading">笔记</div>
      <DomainTree domains={domains} cards={cards} filter={filter} onSelect={(value) => { setFilter(value); setQuery(""); setTreeOpen(false); }} />
      <div className="notes-local-hint"><AppIcon name="folder" size={14} />保存在这台电脑</div>
      {onDataTransfer && <button className="px-4 py-2 text-left text-xs text-dim hover:text-ink" onClick={onDataTransfer}>导出 / 导入笔记</button>}
    </aside>
    <div className="notes-tree-splitter"><Splitter onMouseDown={(e) => startColumnDrag(e, treeW, { min: 170, max: 260, persistKey: TREE_W_KEY }, setTreeW)} /></div>
    <div className="notes-list-column" style={{ width: listW }}>
      <button className="notes-folder-toggle" onClick={() => setTreeOpen((value) => !value)} aria-expanded={treeOpen}><AppIcon name="folder" size={15} />分类与标签</button>
      <NoteList cards={rows} hits={hits} query={query} onQueryChange={setQuery} searching={searching} selected={doc.selected} onSelect={(path) => void doc.open(path)} onCreate={() => void create()} disabled={doc.loading} />
    </div>
    <Splitter onMouseDown={(e) => startColumnDrag(e, listW, { min: 210, max: 350, persistKey: LIST_W_KEY }, setListW)} />
    {doc.selected ? <NoteEditor key={doc.selected} relPath={doc.selected} absPath={selectedCard?.path ?? ""} text={doc.text} loading={doc.loading} dirty={doc.dirty} saving={doc.saving} error={doc.error} onChange={doc.setText} onSave={() => void doc.save()} onDelete={() => void doc.remove()} />
      : <div className="notes-empty"><AppIcon name="note" size={38} /><h2>{doc.loading ? "正在打开笔记…" : "给想法留一个地方"}</h2><p>记下文字，贴上图片，把零散的灵感慢慢收好。</p><button disabled={doc.loading} onClick={() => void create()}><AppIcon name="plus" size={16} />写一篇笔记</button></div>}
  </div>;
}

function Splitter({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return <div className="notes-splitter" onMouseDown={onMouseDown} role="separator" aria-orientation="vertical" />;
}
