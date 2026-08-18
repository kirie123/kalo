import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { chatStore, useChatSelector } from "../lib/chat-store";
import { listDir, searchFiles } from "../lib/pi-bridge";
import { cwdBasename } from "../lib/projects";
import type { FileMatch } from "../types";
import ContextRing from "./ContextRing";
import ModelPicker from "./ModelPicker";

const MAX_TEXTAREA_HEIGHT = 192; // ~8 lines

/** Active autocomplete token: `/cmd` or `@file`, right before the cursor. */
interface AcToken {
  mode: "slash" | "file";
  query: string;
  /** Index in the text where the trigger char (/ or @) sits. */
  start: number;
}

/** Detect a `/...` or `@...` token ending at the cursor (must follow start-of-text or whitespace). */
function detectToken(value: string, cursor: number): AcToken | null {
  const before = value.slice(0, cursor);
  const m = /(?:^|\s)([/:@])([^\s]*)$/.exec(before);
  if (!m) return null;
  return { mode: m[1] === "/" ? "slash" : "file", query: m[2], start: before.length - m[2].length - 1 };
}

/** File types accepted by the attachment picker (images / office / text). */
const ATTACHMENT_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp",
  "pdf", "docx", "xlsx", "pptx", "xls",
  "txt", "md", "csv", "log", "json", "yaml", "yml", "xml",
  "ts", "tsx", "js", "jsx", "py", "rs", "java", "c", "cpp", "h", "go",
  "sh", "bat", "ps1", "sql", "html", "css", "toml",
];

export default function InputBox() {
  // Only the fields the composer actually shows: the timeline churns at
  // ~20fps while streaming and must not re-render the input.
  const chat = useChatSelector((s) => ({
    cwd: s.cwd,
    inputDraft: s.inputDraft,
    commands: s.commands,
    attachments: s.attachments,
    isStreaming: s.isStreaming,
    connecting: s.connecting,
    steeringMode: s.steeringMode,
  }));
  const [text, setText] = useState("");
  const [previewImage, setPreviewImage] = useState<{ name: string; mimeType: string; dataBase64: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Autocomplete state: active token, highlighted row, @ search results.
  const [ac, setAc] = useState<AcToken | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [dragging, setDragging] = useState(false);

  // Auto-grow the textarea (1-8 lines).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  // Draft pushed by an extension (set_editor_text).
  useEffect(() => {
    if (chat.inputDraft !== undefined) {
      setText(chat.inputDraft);
      chatStore.clearInputDraft();
    }
  }, [chat.inputDraft]);

  // Recompute the autocomplete token whenever text or cursor changes.
  const syncAc = (value: string, cursor: number) => {
    const next = detectToken(value, cursor);
    setAc((prev) => {
      if (prev?.mode !== next?.mode || prev?.query !== next?.query) setAcIndex(0);
      return next;
    });
  };

  // Debounced file search for @ completion.
  const acQuery = ac?.mode === "file" ? ac.query : null;
  useEffect(() => {
    if (acQuery === null || !chat.cwd) {
      setFileMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      // Empty query (bare "@"): show the working directory's top-level
      // entries so the menu opens immediately, mirroring "/" behavior.
      const req =
        acQuery === ""
          ? listDir(chat.cwd).then((entries) =>
              entries.slice(0, 50).map((e) => ({ name: e.name, path: e.path, isDir: e.isDir })),
            )
          : searchFiles(chat.cwd, acQuery);
      req.then(setFileMatches).catch(() => setFileMatches([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [acQuery, chat.cwd]);

  const slashItems =
    ac?.mode === "slash"
      ? chat.commands.filter((c) => c.name.toLowerCase().includes(ac.query.toLowerCase())).slice(0, 20)
      : [];
  const fileItems = ac?.mode === "file" ? fileMatches : [];
  const acItemCount = ac?.mode === "slash" ? slashItems.length : fileItems.length;
  const acOpen = ac !== null && acItemCount > 0;

  /** Insert the chosen completion, replacing the token. */
  const applyCompletion = (insertion: string) => {
    if (!ac) return;
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const next = text.slice(0, ac.start) + insertion + text.slice(cursor);
    setText(next);
    setAc(null);
    const pos = ac.start + insertion.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const pickSlash = (name: string) => applyCompletion(`/${name} `);
  const pickFile = (m: FileMatch) => {
    // Prefer a path relative to the working directory (case-insensitive on Windows).
    let p = m.path;
    const cwd = chat.cwd.replace(/[\\/]+$/, "");
    if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + "\\")) p = p.slice(cwd.length + 1);
    else if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + "/")) p = p.slice(cwd.length + 1);
    applyCompletion(`${p}${m.isDir ? "/" : ""} `);
  };

  const send = () => {
    const value = text.trim();
    if (!value && chat.attachments.length === 0) return;
    setText("");
    void chatStore.sendPrompt(value);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete navigation takes precedence over send.
    if (acOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItemCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItemCount) % acItemCount);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (ac?.mode === "slash") pickSlash(slashItems[Math.min(acIndex, slashItems.length - 1)].name);
        else if (ac?.mode === "file") pickFile(fileItems[Math.min(acIndex, fileItems.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAc(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // Ctrl+V: turn pasted files (images, documents, text files) into attachments.
  // Plain-text pastes fall through to the textarea untouched.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    void chatStore.addFiles(files);
  };

  // Drag & drop from the OS. The webview swallows HTML5 drop events
  // (tauri's dragDropEnabled), so we listen on the webview instead — which
  // also hands us real paths, letting us reuse the path-based reader.
  // Anywhere in the window counts as a drop target; the hint is drawn on the
  // composer so the destination stays obvious.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        if (p.paths.length > 0) void chatStore.addAttachments(p.paths);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const pickCwd = async () => {
    try {
      const dir = await open({ directory: true });
      if (typeof dir === "string") await chatStore.setCwd(dir);
    } catch (err) {
      chatStore.pushToast(`选择目录失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const pickAttachments = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "附件", extensions: ATTACHMENT_EXTENSIONS }],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length > 0) void chatStore.addAttachments(paths);
    } catch (err) {
      chatStore.pushToast(`选择附件失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="relative rounded-2xl border border-edge bg-card shadow-lg">
        {/* Drop hint while a file is dragged over the window */}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-card/90 text-xs text-dim">
            松开以添加附件
          </div>
        )}
        {/* Autocomplete popup (/ commands, @ files) */}
        {acOpen && ac && (
          <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 max-h-64 overflow-auto rounded-xl border border-edge bg-card py-1 shadow-2xl">
            {ac.mode === "slash" &&
              slashItems.map((c, i) => (
                <button
                  key={c.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlash(c.name);
                  }}
                  onMouseEnter={() => setAcIndex(i)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs ${
                    i === acIndex ? "bg-base text-ink" : "text-dim"
                  }`}
                >
                  <span className="mono shrink-0 text-ink">/{c.name}</span>
                  {c.description && <span className="truncate">{c.description}</span>}
                </button>
              ))}
            {ac.mode === "file" &&
              fileItems.map((m, i) => (
                <button
                  key={m.path}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickFile(m);
                  }}
                  onMouseEnter={() => setAcIndex(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    i === acIndex ? "bg-base text-ink" : "text-dim"
                  }`}
                >
                  {m.isDir ? <AcFolderIcon /> : <AcFileIcon />}
                  <span className="shrink-0 text-ink">{m.name}</span>
                  <span className="mono truncate">{m.path}</span>
                </button>
              ))}
          </div>
        )}

        {/* Pending attachment chips */}
        {chat.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {chat.attachments.map((a) => (
              <span
                key={a.name}
                className="flex items-center gap-1.5 rounded-md border border-edge bg-base px-2 py-1 text-xs"
              >
                {a.kind === "image" && (
                  <img
                    src={`data:${a.mimeType};base64,${a.dataBase64}`}
                    alt={a.name}
                    title="点击查看大图"
                    onClick={() => setPreviewImage(a)}
                    className="h-6 w-6 cursor-zoom-in rounded object-cover"
                  />
                )}
                <span className="max-w-40 truncate">{a.name}</span>
                <button
                  onClick={() => chatStore.removeAttachment(a.name)}
                  title="移除附件"
                  className="shrink-0 text-dim hover:text-ink"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            syncAc(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => syncAc(text, e.currentTarget.selectionStart ?? text.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={chat.isStreaming ? "输入引导消息，Enter 插入当前运行…" : chat.connecting ? "正在连接引擎，可先发消息…" : "输入消息，Enter 发送，Shift+Enter 换行，可粘贴或拖入文件"}
          className="max-h-48 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm outline-none placeholder:text-dim"
        />

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1">
          <button
            onClick={() => void pickAttachments()}
            title="添加附件"
            className="rounded-full border border-edge p-1.5 text-dim hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
          </button>

          {/* Permission / steering mode */}
          <select
            value={chat.steeringMode}
            onChange={(e) => void chatStore.setSteeringMode(e.target.value as "all" | "one-at-a-time")}
            title="权限模式"
            className="cursor-pointer rounded-md border border-edge bg-transparent px-1.5 py-1 text-xs text-dim outline-none hover:text-ink"
          >
            <option value="one-at-a-time">默认权限</option>
            <option value="all">全部放行</option>
          </select>

          <ContextRing />

          <div className="flex-1" />

          <ModelPicker />

          {chat.isStreaming ? (
            <button
              onClick={() => void chatStore.abort()}
              title="停止生成"
              className="rounded-full bg-accent p-2 text-[var(--accent-contrast)] hover:opacity-90"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!text.trim() && chat.attachments.length === 0}
              title="发送"
              className="rounded-full bg-accent p-2 text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-30"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Working directory row below the card */}
      <div className="mt-1.5 flex items-center px-1">
        <button
          onClick={() => void pickCwd()}
          title={chat.cwd ? `工作目录：${chat.cwd}` : "选择工作目录"}
          className="flex max-w-72 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-dim hover:bg-card hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0">
            <path d="M2 4.5A1.5 1.5 0 013.5 3h2l1.5 2h5.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
          </svg>
          <span className="truncate">{chat.cwd ? cwdBasename(chat.cwd) : "选择工作目录"}</span>
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Image lightbox — portaled to <body> so the chat-area zoom doesn't
          scale its viewport-sized overlay past the actual viewport. */}
      {previewImage &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
            onClick={() => setPreviewImage(null)}
          >
            <div className="flex max-h-full max-w-full flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <img
                src={`data:${previewImage.mimeType};base64,${previewImage.dataBase64}`}
                alt={previewImage.name}
                className="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
              />
              <div className="flex items-center gap-3 text-xs text-white/80">
                <span>{previewImage.name}</span>
                <button onClick={() => setPreviewImage(null)} className="rounded border border-white/30 px-2 py-0.5 hover:bg-white/10">
                  关闭
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function AcFolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2l1.5 2h5.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
    </svg>
  );
}

function AcFileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
      <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
    </svg>
  );
}
