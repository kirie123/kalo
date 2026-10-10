import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { gitDiff, gitStatus, listDir } from "../lib/pi-bridge";
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
import { type ArtifactItem } from "../lib/artifacts";
import ContextMenu, {
  copyLinkItem,
  copyPathItem,
  openPathItem,
  openUrlItem,
  useContextMenu,
  type MenuItem,
} from "./ContextMenu";
import type { DiffLine } from "./DiffView";
import FilePreviewPane from "./FilePreviewPane";
import { normPath } from "../lib/chat-store-helpers";
import {
  adoptPanelMemory,
  closeFileInMemory,
  openFileInMemory,
  openFileOf,
  patchPanelMemory,
  resolvePanelMemory,
  setFileViewInMemory,
  usePanelMemory,
  type FileView,
  type PanelMemory,
} from "../lib/file-panel-memory";
import type { DirEntry, GitEntry, GitStatus } from "../types";

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

/** What a right-click in this panel can land on: a tree / changes row, or one
 * row of the session's artifacts section. */
type MenuTarget = { kind: "entry"; entry: DirEntry } | { kind: "artifact"; item: ArtifactItem };

/** Right-side file browser with a text preview. The tree root follows the
 * session cwd until the user navigates elsewhere via the path bar.
 *
 * What the panel remembers (open file, browsing root, expansion) belongs to the
 * session and lives in lib/file-panel-memory; listings, git status, diff lines,
 * the menu and fullscreen stay transient here. The tab container in
 * RightPanel owns visibility, so this renders no shell of its own — just the
 * preview and tree columns that fill it. */
export default function FilePanel() {
  const cwd = useChatSelector((s) => s.cwd);
  const isStreaming = useChatSelector((s) => s.isStreaming);
  const timeline = useChatSelector((s) => s.timeline);
  const uid = useChatSelector((s) => s.sessionUid);
  const sessionFile = useChatSelector((s) => s.sessionFile);
  const mem = usePanelMemory(uid, cwd);
  const root = mem.root;
  const expanded = useMemo(() => new Set(mem.expanded), [mem.expanded]);
  // The file tabs this session has open, and the one on screen (null = nothing
  // open, so the tree takes the whole column). Both belong to the session and
  // live in lib/file-panel-memory; RightPanel's strip renders the same list
  // (doc/2026-10-10-右栏文件页签.md).
  const files = mem.openFiles;
  const active = openFileOf(mem, mem.activeFile);
  const changesOnly = mem.changesOnly;
  const artifactsOpen = mem.artifactsOpen;
  const backStack = mem.backStack;
  const remember = useCallback((p: Partial<PanelMemory>) => patchPanelMemory(uid, cwd, p), [uid, cwd]);
  // 新对话的会话文件一旦落盘，池键就从 fresh-N 换成文件路径：文件区记忆也跟着
  // 换键，否则引擎被驱逐后再从侧边栏打开同一会话就接不上了。
  useEffect(() => {
    if (sessionFile) adoptPanelMemory(uid, normPath(sessionFile));
  }, [uid, sessionFile]);
  const [pathDraft, setPathDraft] = useState(root);
  // Lazy tree cache: directory path -> its single-level listing.
  const [tree, setTree] = useState<Map<string, DirEntry[]>>(new Map());
  const [previewFull, setPreviewFull] = useState(false);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  /** Which file the loaded diff lines belong to (each tab has its own view). */
  const [diffPath, setDiffPath] = useState<string | null>(null);
  // Right-click target for the shared context menu (its anchor lives in `menu`).
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const menu = useContextMenu();
  const openRowMenu = (e: ReactMouseEvent, entry: DirEntry) => {
    setMenuTarget({ kind: "entry", entry });
    menu.onContextMenu(e);
  };
  const openArtifactMenu = (e: ReactMouseEvent, item: ArtifactItem) => {
    setMenuTarget({ kind: "artifact", item });
    menu.onContextMenu(e);
  };
  // null = not a repository (or git missing): the whole git strip stays hidden.
  const [git, setGit] = useState<GitStatus | null>(null);
  // Shown inline in the git strip rather than as a toast: status is re-read
  // after every turn, and a repeating toast for a persistent problem is noise.
  const [gitError, setGitError] = useState<string | null>(null);
  const [treeW, setTreeW] = useState(() => loadWidth("kalo.layout.treeW", 288));
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
    setPathDraft(root);
  }, [root]);

  /** Navigate the tree to an arbitrary directory (validated first). */
  const navigate = async (path: string, push = true) => {
    const target = path.trim();
    if (!target || target === root) return;
    try {
      // Validated by listing; the effect above reloads the tree for the new
      // root, and a root change drops the expansion in the memory store.
      await listDir(target);
      if (push && root) remember({ rootOverride: target, backStack: [...backStack, root] });
      else remember({ rootOverride: target });
    } catch {
      chatStore.pushToast(`不是有效目录：${target}`, "warning");
      setPathDraft(root);
    }
  };

  /** Back to the previously browsed directory (no stack push). */
  const goBack = () => {
    const prev = backStack[backStack.length - 1];
    if (!prev) return;
    remember({ backStack: backStack.slice(0, -1) });
    void navigate(prev, false);
  };

  const toggleDir = (path: string) => {
    const isOpen = expanded.has(path);
    const next = new Set(expanded);
    if (isOpen) next.delete(path);
    else next.add(path);
    remember({ expanded: [...next] });
    if (!isOpen && !tree.has(path)) void loadDir(path);
  };

  const loadDiff = useCallback(
    async (path: string, relPath: string) => {
      if (!root) return;
      const req = ++diffReq.current;
      setDiffLoading(true);
      setDiffPath(path);
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

  // Session switch (uid) or a new working directory: re-read the tree, git
  // status and diff from disk. The remembered fields come from the memory
  // store, so this never closes a file tab or forgets the expansion.
  useEffect(() => {
    const m = resolvePanelMemory(uid, cwd);
    setTree(new Map());
    setDiffLines(null);
    setDiffPath(null);
    setPreviewFull(false);
    diffReq.current++;
    if (m.root) {
      void loadDir(m.root);
      for (const p of m.expanded) void loadDir(p);
    }
    void refreshGit(m.root);
  }, [uid, cwd, root, loadDir, refreshGit]);

  // The diff view reads lines for the file tab on screen: refetch whenever that
  // tab wants diff and the lines at hand belong to another file (or to nothing
  // — switching sessions drops them). A remembered diff tab has no lines to
  // restore, so it re-reads here like any other.
  useEffect(() => {
    const f = active;
    if (!f || f.view !== "diff" || !f.relPath) return;
    if (diffPath === f.path) return;
    void loadDiff(f.path, f.relPath);
  }, [active?.path, active?.view, active?.relPath, diffPath, loadDiff]);

  // A file tab opened without a repo-relative path (a present_files deliverable
  // is opened by RightPanel, which holds no git snapshot) only becomes
  // diff-able once this panel fills that field in: the git state lives here.
  useEffect(() => {
    if (!git) return;
    let enriched = false;
    const fixed = files.map((f) => {
      const rel = relPathOf(git, f.path);
      if (rel === f.relPath) return f;
      enriched = true;
      return { ...f, relPath: rel };
    });
    if (enriched) remember({ openFiles: fixed });
  }, [git, files, remember]);

  const openFile = useCallback(
    (file: { name: string; path: string }, view: FileView = "source", keepFull = false) => {
      const relPath = relPathOf(git, file.path);
      remember(openFileInMemory(mem, { name: file.name, path: file.path, relPath, view }));
      // No read here: FilePreview owns loading (and its own error state), which
      // is what lets one path serve markdown, images and office files alike.
      // A link clicked inside a rendered document keeps fullscreen: browsing
      // from one doc to the next should not dump the reader back into the
      // narrow column.
      if (!keepFull) setPreviewFull(false);
    },
    [git, mem, remember],
  );

  /** Follow a link clicked inside a previewed document. */
  const openPreviewTarget = (path: string) => openFile({ name: baseName(path), path }, "source", true);

  /** Switch the file tab on screen between 源码 and diff. */
  const selectFileView = (view: FileView) => {
    if (!active) return;
    remember(setFileViewInMemory(mem, active.path, view));
  };

  /** Close the file tab on screen (the ✕ at the right end of its preview row). */
  const closeFile = () => {
    if (!active) return;
    diffReq.current++;
    remember(closeFileInMemory(mem, active.path));
    setPreviewFull(false);
    setDiffLines(null);
    setDiffPath(null);
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

  /** Right-click menu for one tree / changes row. */
  const entryMenuItems = (entry: DirEntry): MenuItem[] => {
    const status = statusOf(gitIndex, entry.path);
    // "查看 diff" only makes sense for a tracked file with recorded changes.
    const canDiff = !entry.isDir && relPathOf(git, entry.path) !== null && status !== null && !status.untracked;
    return [
      ...(entry.isDir ? [] : [openPathItem("打开文件", entry.path)]),
      ...(canDiff ? [{ label: "查看 diff", action: () => openFile(entry, "diff") }] : []),
      // A directory reveals as itself, a file is selected inside its folder;
      // one wording covers both (openPathItem's `reveal` handles the difference).
      openPathItem("打开所在文件夹", entry.path, !entry.isDir),
      ...(entry.isDir
        ? []
        : [{ label: "添加到对话区", action: () => void chatStore.addAttachments([entry.path]) }]),
      copyPathItem(entry.path),
    ];
  };

  /** Right-click menu for one row of the artifacts section (the deliverables
   * this session declared through present_files). */
  const artifactMenuItems = (item: ArtifactItem): MenuItem[] => {
    if (item.kind === "url") return [openUrlItem(item.path), copyLinkItem(item.path)];
    // A missing file can still be revealed or its path copied; opening it and
    // sending it to the chat cannot.
    const openable = item.missing !== true;
    return [
      ...(openable ? [openPathItem("打开文件", item.path)] : []),
      openPathItem("打开所在文件夹", item.path, true),
      ...(openable
        ? [{ label: "添加到对话区", action: () => void chatStore.addAttachments([item.path]) }]
        : []),
      copyPathItem(item.path),
    ];
  };

  const renderRows = (path: string, depth: number): ReactNode => {
    const entries = tree.get(path);
    if (!entries) return null;
    return entries.map((e) => (
      <div key={e.path}>
        <button
          onClick={() => (e.isDir ? toggleDir(e.path) : openFile(e))}
          onContextMenu={(ev) => openRowMenu(ev, e)}
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
              onContextMenu={(ev) => openRowMenu(ev, asEntry)}
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
  const canDiffActive =
    active !== null && active.relPath !== null && !statusOf(gitIndex, active.path)?.untracked;
  /** The lines of the tab on screen (another file's lines never leak in). */
  const diffNow = active !== null && diffPath === active.path ? diffLines : null;
  const diffBusy =
    active !== null &&
    active.view === "diff" &&
    active.relPath !== null &&
    (diffLoading || diffPath !== active.path);

  // Aggregate all present_files declarations from this session's timeline.
  const artifacts = useMemo(() => {
    const recs = timeline
      .filter((e) => e.kind === "artifacts")
      .flatMap((e) => (e as any).summary.items as ArtifactItem[]);
    // Dedup by path, last-wins (matches sessionArtifacts logic).
    const map = new Map<string, ArtifactItem>();
    for (const item of recs) map.set(item.path, item);
    return Array.from(map.values());
  }, [timeline]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Preview column, nearest the chat so reading stays close to the
          conversation; the tree sits on the far side and keeps its own width
          (the panel's left edge is dragged in RightPanel). */}
      {active && !previewFull && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FilePreviewPane
            file={active}
            canDiff={canDiffActive}
            diff={diffNow}
            loading={diffBusy}
            onView={selectFileView}
            onFull={() => setPreviewFull(true)}
            onClose={closeFile}
            onOpenPath={openPreviewTarget}
          />
        </div>
      )}

      {/* Preview | tree splitter: only meaningful while both are on screen. */}
      {active && !previewFull && (
        <div
          onMouseDown={(e) =>
            startColumnDrag(e, treeW, { min: 180, max: 560, invert: true, persistKey: "kalo.layout.treeW" }, setTreeW)
          }
          className="w-1 shrink-0 cursor-col-resize border-l border-edge hover:bg-edge"
        />
      )}

      {/* Tree column: beside a preview it keeps its dragged width; on its own
          it takes the whole tab. */}
      <div
        className={`flex flex-col ${active && !previewFull ? "shrink-0" : "min-w-0 flex-1"}`}
        style={active && !previewFull ? { width: treeW } : undefined}
      >
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
                onClick={() => remember({ changesOnly: !changesOnly })}
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
          {/* Artifacts section: model-declared deliverables from present_files */}
          {artifacts.length > 0 && (
            <div className="border-b border-edge pb-1 mb-1">
              <button
                onClick={() => remember({ artifactsOpen: !artifactsOpen })}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-card"
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                  className={`shrink-0 text-dim transition-transform ${artifactsOpen ? "" : "-rotate-90"}`}>
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-[10px] font-medium uppercase tracking-wide text-dim">产物 {artifacts.length}</span>
              </button>
              {artifactsOpen && artifacts.map((item) => (
                <button
                  key={item.path}
                  onClick={() => {
                    if (item.kind === "file" && !item.missing) {
                      openFile({ name: item.name, path: item.path });
                    }
                  }}
                  title={item.path}
                  onContextMenu={(ev) => openArtifactMenu(ev, item)}
                  // Not `disabled`: Chromium dispatches no mouse events to a
                  // disabled control, so its context menu could never open. The
                  // click guard above already ignores missing entries.
                  aria-disabled={item.missing === true || undefined}
                  className={`flex w-full items-center gap-1.5 py-1 pl-5 pr-2 text-left text-xs hover:bg-card ${
                    item.missing ? "cursor-default opacity-50" : ""
                  }`}
                >
                  {item.kind === "url" ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-tone-blue">
                      <circle cx="8" cy="8" r="6.5" /><path d="M8 1.5c-1.5 1.5-2.5 3.8-2.5 6.5s1 5 2.5 6.5M8 1.5c1.5 1.5 2.5 3.8 2.5 6.5s-1 5-2.5 6.5M1.5 8h13" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-tone-orange">
                      <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
                      <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span className={`min-w-0 flex-1 truncate ${item.primary ? "font-medium text-ink" : "text-dim"}`}>
                    {item.name}
                  </span>
                  {item.missing && <span className="shrink-0 text-[9px] text-dim">缺失</span>}
                </button>
              ))}
            </div>
          )}
          {changesOnly && git ? (
            renderChanges(git)
          ) : root ? (
            renderRows(root, 0) ?? <div className="px-3 py-2 text-xs text-dim">加载中…</div>
          ) : (
            <div className="px-3 py-2 text-xs text-dim">先在输入框下方选择工作目录</div>
          )}
        </div>
      </div>

      {/* Fullscreen preview overlay */}
      {active && previewFull && (
        <div className="fixed inset-x-0 bottom-0 top-8 z-50 flex flex-col bg-base">
          <FilePreviewPane
            file={active}
            canDiff={canDiffActive}
            diff={diffNow}
            loading={diffBusy}
            full
            onView={selectFileView}
            onFull={() => setPreviewFull(false)}
            onClose={closeFile}
            onOpenPath={openPreviewTarget}
          />
        </div>
      )}

      {/* Right-click context menu: a tree / changes row, or an artifacts row */}
      {menu.at && menuTarget && (
        <ContextMenu
          at={menu.at}
          items={
            menuTarget.kind === "entry"
              ? entryMenuItems(menuTarget.entry)
              : artifactMenuItems(menuTarget.item)
          }
          onClose={menu.close}
        />
      )}
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
