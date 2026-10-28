import { useCallback, useEffect, useRef, useState } from "react";
import { chatStore } from "../../lib/chat-store";
import { deleteKnowledgeCard, readKnowledgeCard, writeKnowledgeCard } from "../../lib/pi-bridge";
import { noteTitle } from "./document";
import { NoteSaveQueue } from "./save-queue";
import { errText, noteTemplate } from "./template";

const draftKey = (path: string) => `kalo.notes.draft.${path}`;
interface DocumentState { path: string | null; text: string; base: string }
const emptyDocument = (): DocumentState => ({ path: null, text: "", base: "" });
const noteWriter = new NoteSaveQueue(({ path, text }) => writeKnowledgeCard(path, "cards", "", text));

/** Settings is mounted after the note editor unmounts and enqueues its final save. */
export const waitForNoteWrites = () => noteWriter.idle();

/** IPC and browser persistence live here; document transformations stay in document.ts. */
export function useNoteDocument(onSaved: () => Promise<void>) {
  const [document, setDocument] = useState<DocumentState>(emptyDocument);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(document);
  const alive = useRef(true);
  const transition = useRef(false);
  const writes = useRef(0);
  const draftWarning = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const queue = noteWriter;

  const assign = useCallback((next: DocumentState) => {
    current.current = next;
    if (alive.current) setDocument(next);
  }, []);

  const setText = useCallback((text: string) => {
    if (transition.current || !current.current.path) return;
    const next = { ...current.current, text };
    assign(next);
    setError("");
    try { localStorage.setItem(draftKey(next.path!), text); draftWarning.current = false; }
    catch {
      if (!draftWarning.current) chatStore.pushToast("本地草稿空间不足，请点击保存并确认成功后再关闭笔记", "warning");
      draftWarning.current = true;
    }
  }, [assign]);

  const save = useCallback(async (): Promise<boolean> => {
    const snapshot = { ...current.current };
    if (!snapshot.path || snapshot.text === snapshot.base) { await queue.idle(); return true; }
    writes.current++;
    if (alive.current) setSaving(true);
    try {
      await queue.enqueue({ path: snapshot.path, text: snapshot.text });
      if (current.current.path === snapshot.path) assign({ ...current.current, base: snapshot.text });
      try {
        if (localStorage.getItem(draftKey(snapshot.path)) === snapshot.text) localStorage.removeItem(draftKey(snapshot.path));
      } catch { /* A retained draft is safe; the filesystem write already succeeded. */ }
      if (alive.current) { setError(""); void onSavedRef.current(); }
      return true;
    } catch (err) {
      const message = `保存失败：${errText(err)}。请重试；未保存内容会保留为本地草稿。`;
      if (alive.current) setError(message);
      chatStore.pushToast(message, "error");
      return false;
    } finally {
      writes.current--;
      if (alive.current) setSaving(writes.current > 0);
    }
  }, [assign, queue]);

  const load = useCallback(async (path: string) => {
    await queue.idle();
    queue.forget(path);
    const body = await readKnowledgeCard(path);
    if (!alive.current) return;
    let draft: string | null = null;
    try { draft = localStorage.getItem(draftKey(path)); } catch { /* Reading remains available without draft storage. */ }
    assign({ path, text: draft ?? body, base: body });
    setError("");
    if (draft !== null && draft !== body) chatStore.pushToast("已恢复这篇笔记的未保存草稿", "info");
  }, [assign, queue]);

  const open = useCallback(async (path: string) => {
    if (transition.current || path === current.current.path) return;
    transition.current = true;
    setLoading(true);
    try { if (await save()) await load(path); }
    catch (err) { chatStore.pushToast(`读取笔记失败：${errText(err)}，请重试`, "error"); }
    finally { transition.current = false; if (alive.current) setLoading(false); }
  }, [load, save]);

  const create = useCallback(async (domain: string): Promise<string | null> => {
    if (transition.current) return null;
    transition.current = true;
    setLoading(true);
    try {
      if (!await save()) return null;
      // A unique filename allows multiple untitled notes, including rapid consecutive creation.
      const path = await writeKnowledgeCard(undefined, domain, `note-${crypto.randomUUID()}`, noteTemplate(domain, "未命名笔记"));
      await load(path);
      if (alive.current) await onSavedRef.current();
      return path;
    } catch (err) { chatStore.pushToast(`新建笔记失败：${errText(err)}`, "error"); return null; }
    finally { transition.current = false; if (alive.current) setLoading(false); }
  }, [load, save]);

  const remove = useCallback(async () => {
    const path = current.current.path;
    if (!path || transition.current) return;
    if (!window.confirm(`删除「${noteTitle(current.current.text)}」？旧内容会保留在知识库的 .trash/ 中。`)) return;
    transition.current = true;
    setLoading(true);
    try {
      if (!await save()) return;
      await queue.idle();
      await deleteKnowledgeCard(path);
      try { localStorage.removeItem(draftKey(path)); } catch { /* Deletion must still complete. */ }
      assign(emptyDocument());
      setError("");
      await onSavedRef.current();
    } catch (err) { chatStore.pushToast(`删除笔记失败：${errText(err)}`, "error"); }
    finally { transition.current = false; if (alive.current) setLoading(false); }
  }, [assign, queue, save]);

  useEffect(() => {
    if (!document.path || document.text === document.base || loading || error) return;
    const timer = setTimeout(() => { void save(); }, 1000);
    return () => clearTimeout(timer);
  }, [document, error, loading, save]);

  useEffect(() => {
    alive.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current.text !== current.current.base) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      void save();
    };
  }, [save]);

  return { selected: document.path, text: document.text, dirty: document.text !== document.base, loading, saving, error, setText, save, open, create, remove };
}
