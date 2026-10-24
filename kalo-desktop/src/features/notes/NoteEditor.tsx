import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import AppIcon from "../../components/AppIcon";
import DeliveredImage from "../../components/DeliveredImage";
import { CodeRenderer } from "../../components/MarkdownBlock";
import { chatStore } from "../../lib/chat-store";
import { openPath } from "../../lib/pi-bridge";
import { imageMarkdown, noteBlocks, noteTitle, replaceNoteRange, resolveNoteImage, splitNote, updateNote } from "./document";
import { copyNoteImage, importNoteImage } from "./images";
import { deleteAdjacentNoteImage, removeNoteImage, type ImageDeletion } from "./image-edit";
import { errText } from "./template";
import { useNoteDrop } from "./useNoteDrop";

interface Props {
  relPath: string; absPath: string; text: string; loading: boolean; dirty: boolean; saving: boolean; error: string;
  onChange: (text: string) => void; onSave: () => void; onDelete: () => void;
}

export default function NoteEditor({ relPath, absPath, text, loading, dirty, saving, error, onChange, onSave, onDelete }: Props) {
  const [mode, setMode] = useState<"edit" | "preview" | "source">("edit");
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(text);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const alive = useRef(true);
  const importLock = useRef(false);
  const editorArea = useRef<HTMLElement>(null);
  const pendingFocus = useRef<ImageDeletion | null>(null);
  latest.current = text;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const body = splitNote(text).body;
  const blocks = noteBlocks(body);

  const change = (next: string) => { latest.current = next; onChange(next); };
  const changeBody = (next: string) => change(updateNote(latest.current, { body: next }));

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    if (mode !== "edit" || body !== pending.body) return;
    const input = Array.from(editorArea.current?.querySelectorAll<HTMLTextAreaElement>(".note-text-block") ?? [])
      .find((element) => pending.caret >= Number(element.dataset.start) && pending.caret <= Number(element.dataset.end));
    if (!input) return;
    const offset = pending.caret - Number(input.dataset.start);
    input.focus({ preventScroll: true });
    input.setSelectionRange(offset, offset);
    caret.current = { start: pending.caret, end: pending.caret };
  }, [body, mode]);

  const deleteImage = (result: ImageDeletion | null) => {
    if (!result) return false;
    pendingFocus.current = result;
    changeBody(result.body);
    return true;
  };
  const deletionKey = (event: KeyboardEvent) => !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && (event.key === "Backspace" || event.key === "Delete");

  const insert = (value: string, wrap = false) => {
    const { body: currentBody } = splitNote(latest.current);
    if (mode === "source" && sourceInput.current) {
      const { selectionStart: start, selectionEnd: end } = sourceInput.current;
      change(replaceNoteRange(latest.current, start, end, wrap ? `**${latest.current.slice(start, end) || "文字"}**` : value));
      return;
    }
    const start = Math.min(caret.current?.start ?? currentBody.length, currentBody.length);
    const end = Math.min(caret.current?.end ?? start, currentBody.length);
    const inserted = wrap ? `**${currentBody.slice(start, end) || "文字"}**` : value;
    changeBody(replaceNoteRange(currentBody, start, end, inserted));
    caret.current = { start: start + inserted.length, end: start + inserted.length };
  };

  const addImages = async (sources: Array<File | string>) => {
    if (loading || mode === "preview" || importLock.current || !sources.length) return;
    importLock.current = true;
    setImporting(true);
    try {
      for (const source of sources) {
        const image = typeof source === "string" ? await copyNoteImage(source) : await importNoteImage(source);
        if (!alive.current) return;
        insert(`\n\n${imageMarkdown(image.path, image.name)}\n\n`);
      }
    } catch (err) { if (alive.current) chatStore.pushToast(`添加图片失败：${errText(err)}`, "error"); }
    finally { importLock.current = false; if (alive.current) setImporting(false); }
  };
  const dragging = useNoteDrop(editorArea, (paths) => { void addImages(paths); }, loading || importing || mode === "preview");

  return <section ref={editorArea} className={`note-editor ${dragging ? "note-dragging" : ""}`} aria-label="笔记编辑器"
    onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!loading) onSave(); } }}
    onPaste={(event) => {
      const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
      if (images.length) { event.preventDefault(); void addImages(images); }
    }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => {
      if (event.dataTransfer.files.length) { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)); }
    }}>
    {dragging && <div className="note-drop-hint">松开，将图片加入当前笔记</div>}
    <header className="note-toolbar">
      <div className="note-tools">
        <Tool label="加粗（Markdown）" disabled={loading || mode === "preview"} onClick={() => insert("", true)}><b>B</b></Tool>
        <Tool label="添加待办清单" disabled={loading || mode === "preview"} onClick={() => insert("\n- [ ] ")}><AppIcon name="checklist" /></Tool>
        <Tool label={importing ? "正在导入图片" : "插入图片，也可粘贴或拖入"} disabled={loading || importing || mode === "preview"} onClick={() => fileInput.current?.click()}><AppIcon name="image" /></Tool>
      </div>
      <div className="note-view-modes" aria-label="笔记视图">{([['edit', '编辑'], ['preview', '预览'], ['source', '源码']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} disabled={loading || importing} onClick={() => { setMode(value); caret.current = null; }}>{label}</button>)}</div>
      <div className="note-tools note-actions">
        <button className="note-save" disabled={loading || saving || !dirty} onClick={onSave}>{saving ? "保存中…" : dirty ? "保存" : "已保存"}</button>
        {absPath && <Tool label="在文件管理器中显示" disabled={loading} onClick={() => void openPath(absPath, true).catch((err) => chatStore.pushToast(`打开位置失败：${errText(err)}`, "error"))}><AppIcon name="folder" /></Tool>}
        <Tool label="删除笔记" disabled={loading || importing} onClick={onDelete}><AppIcon name="trash" size={17} /></Tool>
      </div>
      <input type="file" ref={fileInput} accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addImages(files); }} />
    </header>
    {error && <div className="note-save-error" role="alert">{error} <button onClick={onSave} disabled={saving}>重试保存</button></div>}
    {loading ? <div className="note-loading" role="status">正在打开笔记…</div>
      : mode === "source" ? <textarea ref={sourceInput} className="note-source mono" aria-label="Markdown 源码" value={text} onChange={(event) => change(event.target.value)} spellCheck={false} />
      : <div className="note-scroll"><div className="note-paper">
        <div className="note-meta">{importing ? "正在导入图片…" : "个人笔记 · 随手记下，自在整理"}</div>
        {mode === "edit" ? <>
          <input className="note-title" aria-label="笔记标题" value={noteTitle(text, "")} placeholder="未命名笔记" onFocus={(event) => { if (event.target.value === "未命名笔记") event.target.select(); }} onChange={(event) => change(updateNote(latest.current, { title: event.target.value }))} />
          <div className="note-blocks">{blocks.map((block, index) => block.kind === "text"
            ? <AutoText key={index} start={block.start} end={block.end} value={block.value} placeholder={index === 0 ? "从这里开始记录…" : "继续写下你的想法…"}
              onChange={(value) => changeBody(replaceNoteRange(splitNote(latest.current).body, block.start, block.end, value))}
              onKeyDown={(event) => {
                if (!deletionKey(event)) return;
                const input = event.currentTarget;
                if (deleteImage(deleteAdjacentNoteImage(splitNote(latest.current).body, block.start + input.selectionStart, block.start + input.selectionEnd, event.key === "Backspace" ? "backward" : "forward"))) event.preventDefault();
              }}
              onSelect={(start, end) => { caret.current = { start: block.start + start, end: block.start + end }; }} />
            : <figure className="note-image-block" key={index} tabIndex={0} role="group" aria-label={`笔记图片：${block.alt || "图片"}`} aria-keyshortcuts="Backspace Delete"
              onClick={(event) => { if (!(event.target as HTMLElement).closest("img, button")) event.currentTarget.focus(); }}
              onKeyDown={(event) => {
                const target = event.target as HTMLElement;
                if (!deletionKey(event) || !event.currentTarget.contains(target) || (target !== event.currentTarget && target.tagName !== "IMG")) return;
                if (deleteImage(removeNoteImage(splitNote(latest.current).body, block.start))) event.preventDefault();
              }}>
              <DeliveredImage source={resolveNoteImage(block.source, absPath)} alt={block.alt || "笔记图片"} />
              <figcaption><span>{block.alt || "图片"}</span><button onClick={() => deleteImage(removeNoteImage(splitNote(latest.current).body, block.start))} aria-label="从笔记移除图片" title="仅移除笔记内引用，保留原附件"><AppIcon name="trash" size={14} /></button></figcaption>
            </figure>)}</div>
        </> : <><h1 className="note-title">{noteTitle(text)}</h1><div className="markdown note-preview"><ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
          urlTransform={(url, key) => key === "src" ? url : defaultUrlTransform(url)}
          components={{ code: CodeRenderer as any, pre: ({ children }) => <>{children}</>, img: ({ src, alt }) => <DeliveredImage source={resolveNoteImage(src || "", absPath)} alt={alt} /> }}
        >{body}</ReactMarkdown></div></>}
      </div></div>}
    <footer className="note-status"><span title={relPath}>{relPath}</span><span role="status">{error ? "保存失败 · 草稿保留" : saving ? "保存中…" : dirty ? "正在编辑 · 即将自动保存" : "已保存到本地"}</span></footer>
  </section>;
}

function Tool({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button className="note-tool" title={label} aria-label={label} onMouseDown={(event) => event.preventDefault()} disabled={disabled} onClick={onClick}>{children}</button>;
}

function AutoText({ value, start, end, onChange, onSelect, onKeyDown, placeholder }: { value: string; start: number; end: number; onChange: (value: string) => void; onSelect: (start: number, end: number) => void; onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const resize = () => { input.style.height = "0"; input.style.height = `${Math.max(36, input.scrollHeight)}px`; };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(input.parentElement!);
    return () => observer.disconnect();
  }, [value]);
  return <textarea ref={ref} rows={1} className="note-text-block" data-start={start} data-end={end} aria-label="笔记正文" value={value} placeholder={placeholder} onKeyDown={onKeyDown} onChange={(event) => onChange(event.target.value)} onSelect={(event) => onSelect(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} />;
}
