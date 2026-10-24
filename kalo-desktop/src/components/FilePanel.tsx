import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { gitDiff, gitStatus, listDir, searchFiles } from "../lib/pi-bridge";
import { chatStore, useChatSelector } from "../lib/chat-store";
import { loadWidth, startColumnDrag } from "../lib/drag";
import {
  branchLabel,
  buildStatusIndex,
  parseUnifiedDiff,
  pathKey,
  relPathOf,
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
import type { DirEntry, FileMatch, GitStatus } from "../types";
import { fileBaseName as baseName, parentDirectory, pathBreadcrumbs } from "../lib/file-tree";
import AppIcon from "./AppIcon";
import FileTree from "./FileTree";
import FileArtifacts from "./FileArtifacts";
import { createFileRequestGate } from "../lib/file-request-gate";

/** Milliseconds to wait after a turn ends before re-reading git status. */
const TURN_END_DEBOUNCE = 400;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const [treeW, setTreeW] = useState(() => loadWidth("kalo.layout.treeW", 240));
  // Race guard: only the latest diff request may populate its slot.
  const diffReq = useRef(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [treeError, setTreeError] = useState("");
  const [collapsedChanges, setCollapsedChanges] = useState<Set<string>>(new Set());
  // Invalidate immediately on render, before effects can accept an old response.
  const requestGate = useRef(createFileRequestGate());
  const scopeKey = uid + "\0" + root;
  requestGate.current.setScope(scopeKey);

  const gitIndex = useMemo<StatusIndex>(() => buildStatusIndex(git), [git]);

  const loadDir = useCallback(async (path: string) => {
    const request = requestGate.current.start(`dir:${path}`);
    try {
      const entries = await listDir(path);
      if (!requestGate.current.isCurrent(request)) return;
      setTree((m) => new Map(m).set(path, entries));
    } catch (err) {
      if (requestGate.current.isCurrent(request)) setTreeError(errText(err));
    }
  }, []);

  const refreshGit = useCallback(async (path: string | null) => {
    const request = requestGate.current.start("git");
    if (!path) {
      setGit(null);
      setGitError(null);
      return;
    }
    try {
      const status = await gitStatus(path);
      if (!requestGate.current.isCurrent(request)) return;
      setGit(status);
      setGitError(null);
    } catch (err) {
      if (!requestGate.current.isCurrent(request)) return;
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
    const request = requestGate.current.start("navigate");
    try {
      // Validated by listing; the effect above reloads the tree for the new
      // root, and a root change drops the expansion in the memory store.
      await listDir(target);
      if (!requestGate.current.isCurrent(request)) return;
      if (push && root) remember({ rootOverride: target, backStack: [...backStack, root] });
      else remember({ rootOverride: target });
    } catch {
      if (!requestGate.current.isCurrent(request)) return;
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
      const request = requestGate.current.start("diff");
      setDiffLoading(true);
      setDiffPath(path);
      try {
        const text = await gitDiff(root, relPath);
        if (req !== diffReq.current || !requestGate.current.isCurrent(request)) return;
        setDiffLines(parseUnifiedDiff(text));
      } catch (err) {
        if (req !== diffReq.current || !requestGate.current.isCurrent(request)) return;
        setDiffLines([]);
        chatStore.pushToast(`读取 diff 失败：${errText(err)}`, "error");
      } finally {
        if (req === diffReq.current && requestGate.current.isCurrent(request)) setDiffLoading(false);
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
    setTreeError("");
    setGit(null);
    setGitError(null);
    setCollapsedChanges(new Set());
    setQuery("");
    setDiffLoading(false);
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

  useEffect(() => {
    let alive = true;
    const filter = query.trim();
    setResults([]);
    setSearchError("");
    setSearching(Boolean(filter && root && !changesOnly));
    if (!filter || !root || changesOnly) return;
    const timer = setTimeout(() => {
      void searchFiles(root, filter).then((matches) => {
        if (alive) setResults(matches);
      }).catch((err: unknown) => {
        if (alive) setSearchError("查找失败：" + errText(err));
      }).finally(() => { if (alive) setSearching(false); });
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, root, uid, changesOnly]);

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

  // Closing a file from the strip's own × bypasses closeFile above: with no
  // active file there is nothing to show, and leaving fullscreen armed would
  // make the next opened file appear fullscreen.
  useEffect(() => {
    if (mem.activeFile === null) setPreviewFull(false);
  }, [mem.activeFile]);

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
    setTreeError("");
    setDiffPath(null);
    setDiffLines(null);
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

  const showTree = mem.treeVisible || !active;
  const openEntry = (entry: DirEntry, diff = false) => {
    if (entry.isDir) {
      remember({ changesOnly: false, treeVisible: true });
      setQuery("");
      void navigate(entry.path);
    }
    else openFile(entry, diff ? "diff" : "source");
  };
  const navigateFromPreview = (path: string) => { remember({ treeVisible: true }); void navigate(path); };
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
    <div className="file-panel-layout"><div className="file-panel-body">
      {/* Preview column, nearest the chat so reading stays close to the
          conversation; the tree sits on the far side and keeps its own width
          (the panel's left edge is dragged in RightPanel). */}
      {active && !previewFull && (
        <div className="file-reading">
          <FilePreviewPane
            file={active}
            onNavigate={navigateFromPreview}
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
      {active && !previewFull && showTree && (
        <div
          onMouseDown={(e) =>
            startColumnDrag(e, treeW, { min: 180, max: 560, invert: true, persistKey: "kalo.layout.treeW" }, setTreeW)
          }
          className="file-tree-splitter"
        />
      )}

      {showTree && <section className={active && !previewFull ? "file-browser with-preview" : "file-browser"} style={active && !previewFull ? { width: treeW } : undefined} aria-label="文件浏览器">
        <div className="file-browser-heading">
          <AppIcon name="folder" size={15} /><strong>{baseName(root) || "工作区"}</strong>
          <button title="收起全部目录" aria-label="收起全部目录" onClick={() => {
            remember({ expanded: [] });
            setCollapsedChanges(new Set((git?.entries ?? []).flatMap((entry) => pathBreadcrumbs(entry.path).slice(0, -1).map((crumb) => pathKey(crumb.path)))));
          }}>⊟</button>
          <button title="刷新目录与变更" aria-label="刷新目录与变更" onClick={refresh}>↻</button>
        </div>
        <div className="file-location">
          <button title="后退到上次目录" aria-label="后退到上次目录" disabled={!backStack.length} onClick={goBack}>‹</button>
          <button title="上一级" aria-label="上一级" disabled={!parentDirectory(root)} onClick={() => { const parent = parentDirectory(root); if (parent) void navigate(parent); }}>↑</button>
          <input value={pathDraft} aria-label="浏览目录路径" onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") void navigate(pathDraft);
            if (event.key === "Escape") setPathDraft(root);
          }} placeholder="输入目录路径…" spellCheck={false} />
        </div>
        <div className="file-filter"><AppIcon name="search" size={14} />
          <input value={query} aria-label="筛选文件" placeholder={changesOnly && git ? "筛选变更路径…" : "按文件名筛选…"} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setQuery(""); } }} />
          {query && <button title="清除筛选" aria-label="清除筛选" onClick={() => setQuery("")}>×</button>}
        </div>
        {git && <div className="file-git-summary"><BranchIcon /><span title={git.upstream || "没有 upstream"}>{branchLabel(git)}</span><small>{git.truncated ? "部分结果" : changedCount ? changedCount + " 处改动" : "干净"}</small></div>}
        {git && <div className="file-tree-modes" aria-label="文件范围">
          <button aria-pressed={!changesOnly} onClick={() => remember({ changesOnly: false })}>全部文件</button>
          <button aria-pressed={changesOnly} onClick={() => remember({ changesOnly: true })}>更改 <small>{changedCount}{git.truncated ? "+" : ""}</small></button>
        </div>}
        {gitError && <div className="file-tree-empty" role="alert">Git 状态读取失败：{gitError}</div>}
        {treeError && <div className="file-tree-empty" role="alert">读取目录失败：{treeError} <button onClick={refresh}>重试</button></div>}
        <div className="file-browser-scroll">
          <FileArtifacts items={artifacts} open={artifactsOpen} onToggle={() => remember({ artifactsOpen: !artifactsOpen })}
            onOpen={(item) => openFile(item)} onMenu={openArtifactMenu} />
          <FileTree root={changesOnly && git ? git.repoRoot : root} tree={tree} expanded={expanded} activePath={active?.path} index={gitIndex}
            changes={changesOnly && git ? git.entries : null} collapsed={collapsedChanges} query={query} results={results} searching={searching} searchError={searchError}
            onToggle={toggleDir} onToggleChange={(path) => setCollapsedChanges((current) => { const next = new Set(current); const key = pathKey(path); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
            onOpen={openEntry} onMenu={openRowMenu} />
        </div>
      </section>}
      </div>

      {/* Fullscreen preview overlay */}
      {active && previewFull && (
        <div className="file-fullscreen">
          <FilePreviewPane
            file={active}
            canDiff={canDiffActive}
            diff={diffNow}
            loading={diffBusy}
            full
            onNavigate={navigateFromPreview}
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
