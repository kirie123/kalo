import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listDir, openPath, readFileText } from "../lib/pi-bridge";
import { chatStore, useChatStore } from "../lib/chat-store";
import { loadWidth, startColumnDrag } from "../lib/drag";
import type { DirEntry } from "../types";

interface Preview {
  name: string;
  text: string;
  truncated: boolean;
  binary: boolean;
}

interface MenuState {
  x: number;
  y: number;
  entry: DirEntry;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parent of a filesystem path, tolerating both separators; null at a root. */
function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return null;
  if (i === 0) return trimmed.slice(0, 1); // unix root
  // Windows drive root like C:\
  if (i === 2 && trimmed[1] === ":") return trimmed.slice(0, 3);
  return trimmed.slice(0, i);
}

/** Right-side file browser with a text preview. The tree root follows the
 * session cwd until the user navigates elsewhere via the path bar. */
export default function FilePanel() {
  const { cwd } = useChatStore();
  const [rootOverride, setRootOverride] = useState<string | null>(null);
  const root = rootOverride ?? cwd;
  const [pathDraft, setPathDraft] = useState(root ?? "");
  // Lazy tree cache: directory path -> its single-level listing.
  const [tree, setTree] = useState<Map<string, DirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFull, setPreviewFull] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Back navigation: every root change pushes the previous root.
  const [backStack, setBackStack] = useState<string[]>([]);
  const [treeW, setTreeW] = useState(() => loadWidth("kalo.layout.treeW", 288));
  const [previewW, setPreviewW] = useState(() => loadWidth("kalo.layout.previewW", 416));
  // Race guard: only the latest file click may populate the preview.
  const previewReq = useRef(0);

  const loadDir = useCallback(async (path: string) => {
    try {
      const entries = await listDir(path);
      setTree((m) => new Map(m).set(path, entries));
    } catch (err) {
      chatStore.pushToast(`读取目录失败：${errText(err)}`, "error");
    }
  }, []);

  // Reset and reload whenever the root changes (cwd switch or path-bar nav).
  useEffect(() => {
    setTree(new Map());
    setExpanded(new Set());
    setPreview(null);
    setPreviewFull(false);
    previewReq.current++;
    if (root) void loadDir(root);
  }, [root, loadDir]);

  // Keep the path bar in sync when the root changes from outside.
  useEffect(() => {
    setPathDraft(root ?? "");
  }, [root]);

  /** Navigate the tree to an arbitrary directory (validated first). */
  const navigate = async (path: string, push = true) => {
    const target = path.trim();
    if (!target || target === root) return;
    try {
      const entries = await listDir(target);
      if (push && root) setBackStack((s) => [...s, root]);
      setRootOverride(target);
      setTree(new Map([[target, entries]]));
      setExpanded(new Set());
      setPreview(null);
    } catch {
      chatStore.pushToast(`不是有效目录：${target}`, "warning");
      setPathDraft(root ?? "");
    }
  };

  /** Back to the previously browsed directory (no stack push). */
  const goBack = () => {
    const prev = backStack[backStack.length - 1];
    if (!prev) return;
    setBackStack((s) => s.slice(0, -1));
    void navigate(prev, false);
  };

  const toggleDir = (path: string) => {
    const isOpen = expanded.has(path);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!isOpen && !tree.has(path)) void loadDir(path);
  };

  const openFile = async (entry: DirEntry) => {
    const req = ++previewReq.current;
    try {
      const res = await readFileText(entry.path);
      if (req !== previewReq.current) return;
      setPreview({ name: entry.name, ...res });
      setPreviewFull(false);
    } catch (err) {
      if (req === previewReq.current) {
        chatStore.pushToast(`读取文件失败：${errText(err)}`, "error");
      }
    }
  };

  const closePreview = () => {
    previewReq.current++;
    setPreview(null);
    setPreviewFull(false);
  };

  // Reload the root and every expanded directory, keeping the expansion.
  const refresh = () => {
    if (!root) return;
    const paths = [root, ...expanded];
    setTree(new Map());
    for (const p of paths) void loadDir(p);
  };

  const renderRows = (path: string, depth: number): ReactNode => {
    const entries = tree.get(path);
    if (!entries) return null;
    return entries.map((e) => (
      <div key={e.path}>
        <button
          onClick={() => (e.isDir ? toggleDir(e.path) : void openFile(e))}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
          }}
          title={e.path}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs hover:bg-card"
        >
          {e.isDir ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className={`shrink-0 text-dim transition-transform ${expanded.has(e.path) ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <span className="w-2.5 shrink-0" />
          )}
          {e.isDir ? <FolderIcon /> : <FileIcon />}
          <span className="truncate">{e.name}</span>
        </button>
        {e.isDir && expanded.has(e.path) && renderRows(e.path, depth + 1)}
      </div>
    ));
  };

  return (
    <aside className="flex shrink-0 border-l border-edge">
      {/* Panel left-edge splitter (chat | tree) */}
      <div
        onMouseDown={(e) =>
          startColumnDrag(e, treeW, { min: 180, max: 560, invert: true, persistKey: "kalo.layout.treeW" }, setTreeW)
        }
        className="w-1 shrink-0 cursor-col-resize hover:bg-edge"
      />

      {/* Tree column */}
      <div className="flex shrink-0 flex-col" style={{ width: treeW }}>
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
          <span className="text-xs font-medium">文件</span>
          <button
            onClick={refresh}
            title="刷新"
            className="rounded-md p-1.5 text-dim hover:bg-card hover:text-ink"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path
                d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2.5v2.6h-2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* Path bar: edit to browse any directory */}
        <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5">
          <button
            onClick={goBack}
            disabled={backStack.length === 0}
            title="后退到上次目录"
            className="shrink-0 rounded p-1 text-dim hover:bg-card hover:text-ink disabled:opacity-30"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => {
              const parent = root ? parentDir(root) : null;
              if (parent) void navigate(parent);
            }}
            title="上一级"
            className="shrink-0 rounded p-1 text-dim hover:bg-card hover:text-ink"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 12V4M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void navigate(pathDraft);
            }}
            placeholder="输入路径浏览任意目录…"
            spellCheck={false}
            className="mono min-w-0 flex-1 bg-transparent text-xs text-dim outline-none placeholder:text-dim/60 focus:text-ink"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {root ? (
            renderRows(root, 0) ?? <div className="px-3 py-2 text-xs text-dim">加载中…</div>
          ) : (
            <div className="px-3 py-2 text-xs text-dim">先在输入框下方选择工作目录</div>
          )}
        </div>
      </div>

      {/* Preview column, side by side with the tree */}
      {preview && !previewFull && (
        <>
          {/* Tree | preview splitter */}
          <div
            onMouseDown={(e) =>
              startColumnDrag(e, previewW, { min: 240, max: 960, invert: true, persistKey: "kalo.layout.previewW" }, setPreviewW)
            }
            className="w-1 shrink-0 cursor-col-resize border-l border-edge hover:bg-edge"
          />
          <div className="flex shrink-0 flex-col" style={{ width: previewW }}>
            <PreviewHeader
              name={preview.name}
              onFull={() => setPreviewFull(true)}
              onClose={closePreview}
            />
            <PreviewBody preview={preview} />
          </div>
        </>
      )}

      {/* Fullscreen preview overlay */}
      {preview && previewFull && (
        <div className="fixed inset-0 z-50 flex flex-col bg-base">
          <PreviewHeader
            name={preview.name}
            full
            onFull={() => setPreviewFull(false)}
            onClose={closePreview}
          />
          <PreviewBody preview={preview} />
        </div>
      )}

      {/* Right-click context menu */}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { entry } = menu;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const items: Array<{ label: string; action: () => void }> = [
    ...(entry.isDir
      ? []
      : [{ label: "打开文件", action: () => void openPath(entry.path).catch((e) => chatStore.pushToast(`打开失败：${errText(e)}`, "error")) }]),
    {
      label: entry.isDir ? "打开所在位置" : "打开所在路径",
      action: () =>
        void openPath(entry.path, !entry.isDir).catch((e) => chatStore.pushToast(`打开失败：${errText(e)}`, "error")),
    },
    ...(entry.isDir
      ? []
      : [
          {
            label: "添加到对话区",
            action: () => {
              void chatStore.addAttachments([entry.path]);
            },
          },
        ]),
    {
      label: "复制路径",
      action: () => {
        void navigator.clipboard.writeText(entry.path).then(
          () => chatStore.pushToast("路径已复制", "info"),
          () => chatStore.pushToast("复制失败", "warning"),
        );
      },
    },
  ];

  // Keep the menu inside the window.
  const x = Math.min(menu.x, window.innerWidth - 180);
  const y = Math.min(menu.y, window.innerHeight - items.length * 34 - 16);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="absolute min-w-40 rounded-lg border border-edge bg-card py-1 shadow-2xl"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            onClick={run(item.action)}
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink hover:bg-base"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PreviewHeader({
  name,
  full,
  onFull,
  onClose,
}: {
  name: string;
  full?: boolean;
  onFull: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-edge px-3">
      <span className="truncate text-xs font-medium">{name}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onFull}
          title={full ? "退出全屏" : "全屏查看"}
          className="rounded p-1 text-dim hover:bg-card hover:text-ink"
        >
          {full ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M6 2.5v3h-3M10 13.5v-3h3M13.5 10h-3v3M2.5 6h3v-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <button
          onClick={onClose}
          title="关闭预览"
          className="rounded p-1 text-dim hover:bg-card hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function PreviewBody({ preview }: { preview: Preview }) {
  return (
    <div className="mono min-h-0 flex-1 overflow-auto whitespace-pre px-3 py-2 text-xs leading-relaxed">
      {preview.binary ? "二进制文件不支持预览" : preview.text + (preview.truncated ? "\n（已截断）" : "")}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2l1.5 2h5.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
      <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
    </svg>
  );
}
