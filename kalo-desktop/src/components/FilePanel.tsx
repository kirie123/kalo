import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { gitDiff, gitStatus, listDir, openPath } from "../lib/pi-bridge";
import { chatStore, useChatSelector } from "../lib/chat-store";
import { loadWidth, startColumnDrag } from "../lib/drag";
import {
  branchLabel,
  buildStatusIndex,
  groupByDir,
  parseUnifiedDiff,
  pathKey,
  relPathOf,
  statusColor,
  statusLetter,
  statusOf,
  type StatusIndex,
} from "../lib/git";
import DiffView, { type DiffLine } from "./DiffView";
import FilePreview from "./FilePreview";
import type { DirEntry, GitEntry, GitStatus } from "../types";

interface Preview {
  name: string;
  path: string;
  /** Posix path relative to the repo root; null outside a repository. */
  relPath: string | null;
}

/** Which view the preview column is showing. */
type PreviewTab = "source" | "diff";

interface MenuState {
  x: number;
  y: number;
  entry: DirEntry;
}

/** Milliseconds to wait after a turn ends before re-reading git status. */
const TURN_END_DEBOUNCE = 400;

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

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/** A git entry, adapted to what the tree's click and menu handlers expect. */
function asDirEntry(entry: GitEntry): DirEntry {
  return { name: baseName(entry.relPath), path: entry.path, isDir: entry.isDir, size: 0, modifiedMs: 0 };
}

/** Right-side file browser with a text preview. The tree root follows the
 * session cwd until the user navigates elsewhere via the path bar. */
export default function FilePanel() {
  const cwd = useChatSelector((s) => s.cwd);
  const isStreaming = useChatSelector((s) => s.isStreaming);
  const [rootOverride, setRootOverride] = useState<string | null>(null);
  const root = rootOverride ?? cwd;
  const [pathDraft, setPathDraft] = useState(root ?? "");
  // Lazy tree cache: directory path -> its single-level listing.
  const [tree, setTree] = useState<Map<string, DirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFull, setPreviewFull] = useState(false);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("source");
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // null = not a repository (or git missing): the whole git strip stays hidden.
  const [git, setGit] = useState<GitStatus | null>(null);
  // Shown inline in the git strip rather than as a toast: status is re-read
  // after every turn, and a repeating toast for a persistent problem is noise.
  const [gitError, setGitError] = useState<string | null>(null);
  const [changesOnly, setChangesOnly] = useState(false);
  // Back navigation: every root change pushes the previous root.
  const [backStack, setBackStack] = useState<string[]>([]);
  const [treeW, setTreeW] = useState(() => loadWidth("kalo.layout.treeW", 288));
  const [previewW, setPreviewW] = useState(() => loadWidth("kalo.layout.previewW", 416));
  // Race guard: only the latest diff request may populate its slot.
  const diffReq = useRef(0);

  const gitIndex = useMemo<StatusIndex>(() => buildStatusIndex(git), [git]);

  const loadDir = useCallback(async (path: string) => {
    try {
      const entries = await listDir(path);
      setTree((m) => new Map(m).set(path, entries));
    } catch (err) {
      chatStore.pushToast(`读取目录失败：${errText(err)}`, "error");
    }
  }, []);

  const refreshGit = useCallback(async (path: string | null) => {
    if (!path) {
      setGit(null);
      setGitError(null);
      return;
    }
    try {
      setGit(await gitStatus(path));
      setGitError(null);
    } catch (err) {
      // A real repository whose status failed — keep the last snapshot out of
      // the way and say why, once, in place.
      setGit(null);
      setGitError(errText(err));
    }
  }, []);

  // Reset and reload whenever the root changes (cwd switch or path-bar nav).
  useEffect(() => {
    setTree(new Map());
    setExpanded(new Set());
    setPreview(null);
    setPreviewFull(false);
    setDiffLines(null);
    diffReq.current++;
    if (root) void loadDir(root);
    void refreshGit(root);
  }, [root, loadDir, refreshGit]);

  // Re-read git status when a turn ends: that is exactly when the agent has
  // finished writing files. Debounced, because a burst of turns is common.
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    const ended = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    if (!ended || !root) return;
    const timer = setTimeout(() => void refreshGit(root), TURN_END_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [isStreaming, root, refreshGit]);

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

  const loadDiff = useCallback(
    async (relPath: string) => {
      if (!root) return;
      const req = ++diffReq.current;
      setDiffLoading(true);
      try {
        const text = await gitDiff(root, relPath);
        if (req !== diffReq.current) return;
        setDiffLines(parseUnifiedDiff(text));
      } catch (err) {
        if (req !== diffReq.current) return;
        setDiffLines([]);
        chatStore.pushToast(`读取 diff 失败：${errText(err)}`, "error");
      } finally {
        if (req === diffReq.current) setDiffLoading(false);
      }
    },
    [root],
  );

  const openFile = (file: { name: string; path: string }, tab: PreviewTab = "source") => {
    const relPath = relPathOf(git, file.path);
    setPreviewTab(tab);
    setDiffLines(null);
    diffReq.current++;
    if (tab === "diff" && relPath) void loadDiff(relPath);
    // No read here: FilePreview owns loading (and its own error state), which
    // is what lets one path serve markdown, images and office files alike.
    setPreview({ name: file.name, path: file.path, relPath });
    setPreviewFull(false);
  };

  /** Switch the preview between source and diff, fetching the diff on demand. */
  const selectTab = (tab: PreviewTab) => {
    setPreviewTab(tab);
    if (tab === "diff" && !diffLines && !diffLoading && preview?.relPath) {
      void loadDiff(preview.relPath);
    }
  };

  const closePreview = () => {
    diffReq.current++;
    setPreview(null);
    setPreviewFull(false);
    setPreviewTab("source");
    setDiffLines(null);
  };

  // Esc exits the fullscreen preview. Registered only while fullscreen so a
  // plain Esc elsewhere in the panel is untouched; mirrors FileViewerModal,
  // where Esc likewise steps back before closing anything.
  useEffect(() => {
    if (!previewFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPreviewFull(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewFull]);

  // Reload the root, every expanded directory, and git status, keeping the
  // expansion.
  const refresh = () => {
    if (!root) return;
    const paths = [root, ...expanded];
    setTree(new Map());
    for (const p of paths) void loadDir(p);
    void refreshGit(root);
  };

  const renderRows = (path: string, depth: number): ReactNode => {
    const entries = tree.get(path);
    if (!entries) return null;
    return entries.map((e) => (
      <div key={e.path}>
        <button
          onClick={() => (e.isDir ? toggleDir(e.path) : openFile(e))}
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
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {e.isDir ? <DirBadge index={gitIndex} path={e.path} /> : <FileBadge entry={statusOf(gitIndex, e.path)} />}
        </button>
        {e.isDir && expanded.has(e.path) && renderRows(e.path, depth + 1)}
      </div>
    ));
  };

  /** Flat, directory-grouped list of everything git reports as changed. */
  const renderChanges = (status: GitStatus): ReactNode => {
    if (status.entries.length === 0) {
      return <div className="px-3 py-2 text-xs text-dim">工作区干净，没有未提交的改动。</div>;
    }
    return groupByDir(status).map((group) => (
      <div key={group.dir || "."}>
        <div className="mono truncate px-2 py-1 text-[10px] text-dim" title={group.dir}>
          {group.dir || "（仓库根）"}
        </div>
        {group.entries.map((entry) => {
          const asEntry = asDirEntry(entry);
          return (
            <button
              key={entry.path}
              onClick={() => openFile(asEntry, entry.untracked ? "source" : "diff")}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setMenu({ x: ev.clientX, y: ev.clientY, entry: asEntry });
              }}
              title={entry.renamedFrom ? `${entry.path}\n（原名 ${entry.renamedFrom}）` : entry.path}
              className="flex w-full items-center gap-1.5 py-1 pl-4 pr-2 text-left text-xs hover:bg-card"
            >
              {entry.isDir ? <FolderIcon /> : <FileIcon />}
              <span className="min-w-0 flex-1 truncate">{asEntry.name}</span>
              <FileBadge entry={entry} />
            </button>
          );
        })}
      </div>
    ));
  };

  const changedCount = git?.entries.length ?? 0;
  const canDiff = preview !== null && preview.relPath !== null && !statusOf(gitIndex, preview.path)?.untracked;

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

        {/* Git strip: hidden entirely outside a repository */}
        {git && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1">
            <BranchIcon />
            <span
              className="mono min-w-0 truncate text-[11px] text-dim"
              title={git.upstream ? `upstream: ${git.upstream}` : "没有 upstream"}
            >
              {branchLabel(git)}
            </span>
            <span className="flex-1" />
            {changedCount === 0 ? (
              <span className="shrink-0 text-[10px] text-dim">干净</span>
            ) : (
              <button
                onClick={() => setChangesOnly((v) => !v)}
                title={changesOnly ? "显示完整目录树" : "只列出未提交的改动"}
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                  changesOnly ? "bg-card text-ink" : "text-dim hover:bg-card hover:text-ink"
                }`}
              >
                仅变更 {changedCount}
                {git.truncated ? "+" : ""}
              </button>
            )}
          </div>
        )}
        {gitError && (
          <div className="shrink-0 truncate border-b border-edge px-2 py-1 text-[10px] text-dim" title={gitError}>
            git 状态读取失败：{gitError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {changesOnly && git ? (
            renderChanges(git)
          ) : root ? (
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
              tab={previewTab}
              canDiff={canDiff}
              onTab={selectTab}
              onFull={() => setPreviewFull(true)}
              onClose={closePreview}
            />
            <PreviewBody preview={preview} tab={previewTab} diff={diffLines} loading={diffLoading} />
          </div>
        </>
      )}

      {/* Fullscreen preview overlay */}
      {preview && previewFull && (
        <div className="fixed inset-0 z-50 flex flex-col bg-base">
          <PreviewHeader
            name={preview.name}
            tab={previewTab}
            canDiff={canDiff}
            onTab={selectTab}
            full
            onFull={() => setPreviewFull(false)}
            onClose={closePreview}
          />
          <PreviewBody preview={preview} tab={previewTab} diff={diffLines} loading={diffLoading} />
        </div>
      )}

      {/* Right-click context menu */}
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onViewDiff={
            !menu.entry.isDir &&
            relPathOf(git, menu.entry.path) !== null &&
            statusOf(gitIndex, menu.entry.path) !== null &&
            !statusOf(gitIndex, menu.entry.path)?.untracked
              ? () => openFile(menu.entry, "diff")
              : undefined
          }
        />
      )}
    </aside>
  );
}

function ContextMenu({
  menu,
  onClose,
  onViewDiff,
}: {
  menu: MenuState;
  onClose: () => void;
  /** Omitted when the entry has no diff to show (unchanged, untracked, a dir). */
  onViewDiff?: () => void;
}) {
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
    ...(onViewDiff ? [{ label: "查看 diff", action: onViewDiff }] : []),
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
  tab,
  canDiff,
  onTab,
  full,
  onFull,
  onClose,
}: {
  name: string;
  tab: PreviewTab;
  canDiff: boolean;
  onTab: (tab: PreviewTab) => void;
  full?: boolean;
  onFull: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-edge px-3">
      <span className="min-w-0 truncate text-xs font-medium">{name}</span>
      <div className="flex shrink-0 items-center gap-1">
        {canDiff && (
          <div className="mr-1 flex items-center overflow-hidden rounded-md border border-edge text-[10px]">
            {(["source", "diff"] as const).map((t) => (
              <button
                key={t}
                onClick={() => onTab(t)}
                className={`px-1.5 py-0.5 ${tab === t ? "bg-card text-ink" : "text-dim hover:text-ink"}`}
              >
                {t === "source" ? "源码" : "diff"}
              </button>
            ))}
          </div>
        )}
        {full ? (
          // Fullscreen traps the user when the only exit is a bare icon: make
          // it a labelled button with the shortcut spelled out.
          <button
            onClick={onFull}
            title="退出全屏（Esc）"
            className="flex items-center gap-1.5 rounded-md border border-edge bg-card px-2 py-1 text-xs text-ink hover:bg-base"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M6 2.5v3h-3M10 13.5v-3h3M13.5 10h-3v3M2.5 6h3v-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            退出全屏
            <kbd className="rounded border border-edge bg-base px-1 text-[10px] text-dim">Esc</kbd>
          </button>
        ) : (
          <button
            onClick={onFull}
            title="全屏查看"
            className="rounded p-1 text-dim hover:bg-card hover:text-ink"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
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

function PreviewBody({
  preview,
  tab,
  diff,
  loading,
}: {
  preview: Preview;
  tab: PreviewTab;
  diff: DiffLine[] | null;
  loading: boolean;
}) {
  if (tab === "diff") {
    if (loading) {
      return <div className="min-h-0 flex-1 px-3 py-2 text-xs text-dim">读取 diff…</div>;
    }
    if (!diff || diff.length === 0) {
      return (
        <div className="min-h-0 flex-1 px-3 py-2 text-xs text-dim">
          与 HEAD 无差异。（未跟踪的新文件没有 diff，切到「源码」看内容。）
        </div>
      );
    }
    return (
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <DiffView lines={diff} />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <FilePreview path={preview.path} name={preview.name} />
    </div>
  );
}

/** Status letter plus line counts at the end of a file row. */
function FileBadge({ entry }: { entry: GitEntry | null }) {
  const letter = statusLetter(entry);
  if (!letter || !entry) return null;
  const counts =
    entry.binary
      ? "bin"
      : [entry.added ? `+${entry.added}` : "", entry.removed ? `-${entry.removed}` : ""]
          .filter(Boolean)
          .join(" ");
  return (
    <span className="mono flex shrink-0 items-center gap-1 text-[10px]">
      {counts && <span className="text-dim">{counts}</span>}
      <span className={statusColor(letter)}>{letter}</span>
    </span>
  );
}

/** A dot on a directory that has changes somewhere beneath it. */
function DirBadge({ index, path }: { index: StatusIndex; path: string }) {
  const own = statusOf(index, path);
  if (own?.untracked) {
    return <span className="mono shrink-0 text-[10px] text-dim">?</span>;
  }
  const roll = index.dirs.get(pathKey(path));
  if (!roll || roll.count === 0) return null;
  return (
    <span className="shrink-0 text-[10px] text-amber-500" title={`${roll.count} 处改动`}>
      ●
    </span>
  );
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="6.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 8.1c0 2-1.7 2.8-3.5 2.8h-2" strokeLinecap="round" />
    </svg>
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
