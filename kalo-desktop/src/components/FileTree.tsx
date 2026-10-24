import type { MouseEvent, ReactNode } from "react";
import type { DirEntry, FileMatch, GitEntry } from "../types";
import { pathKey, statusColor, statusLetter, statusOf, type StatusIndex } from "../lib/git";
import { changedFileTree, type ChangeNode } from "../lib/file-tree";
import AppIcon from "./AppIcon";

interface Props {
  root: string;
  tree: Map<string, DirEntry[]>;
  expanded: Set<string>;
  activePath?: string;
  index: StatusIndex;
  changes: GitEntry[] | null;
  collapsed: Set<string>;
  query: string;
  results: FileMatch[];
  searching: boolean;
  searchError: string;
  onToggle: (path: string) => void;
  onToggleChange: (path: string) => void;
  onOpen: (entry: DirEntry, diff?: boolean) => void;
  onMenu: (event: MouseEvent, entry: DirEntry) => void;
}

const asEntry = (entry: FileMatch): DirEntry => ({ ...entry, size: 0, modifiedMs: 0 });

export default function FileTree(props: Props) {
  const { root, tree, expanded, activePath, index, changes, collapsed, query, results, searching, searchError, onToggle, onToggleChange, onOpen, onMenu } = props;
  const row = (entry: DirEntry, depth: number, open: boolean | undefined, action: () => void, status = statusOf(index, entry.path), detail?: string) => <button
    key={entry.path} role="treeitem" aria-level={depth + 1} aria-expanded={entry.isDir ? open : undefined}
    aria-selected={!entry.isDir && !!activePath && pathKey(entry.path) === pathKey(activePath)}
    className="file-tree-row" style={{ paddingLeft: 10 + depth * 14 }} title={entry.path}
    onClick={action} onContextMenu={(event) => onMenu(event, entry)}
    onKeyDown={(event) => {
      if (entry.isDir && ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open))) { event.preventDefault(); action(); }
    }}>
    <span className={`file-tree-chevron ${open ? "is-open" : ""}`}>{entry.isDir ? "›" : ""}</span>
    <AppIcon name={entry.isDir ? "folder" : "file"} size={14} />
    <span className="file-tree-name"><span>{entry.name}</span>{detail && <small>{detail}</small>}</span>
    {entry.isDir ? <DirectoryBadge index={index} path={entry.path} /> : <FileStatusBadge entry={status} />}
  </button>;

  const directories = (path: string, depth: number): ReactNode => tree.get(path)?.map((entry) => <div key={entry.path} role="none">
    {row(entry, depth, expanded.has(entry.path), () => entry.isDir ? onToggle(entry.path) : onOpen(entry))}
    {entry.isDir && expanded.has(entry.path) && <div role="group">{directories(entry.path, depth + 1)}</div>}
  </div>);

  const changedRows = (nodes: ChangeNode[], depth: number): ReactNode => nodes.map((node) => {
    const open = !collapsed.has(pathKey(node.path));
    const entry = asEntry(node);
    return <div key={node.path} role="none">
      {row(entry, depth, open, () => node.isDir ? node.children.length ? onToggleChange(node.path) : onOpen(entry) : onOpen(entry, !node.entry?.untracked), node.entry)}
      {node.isDir && open && node.children.length > 0 && <div role="group">{changedRows(node.children, depth + 1)}</div>}
    </div>;
  });

  let content: ReactNode;
  if (changes) {
    const nodes = changedFileTree(root, changes, query);
    content = nodes.length ? changedRows(nodes, 0) : <div className="file-tree-empty">{query ? "没有匹配的变更文件" : "工作区干净，没有未提交的改动"}</div>;
  } else if (query.trim()) {
    content = searching ? <div className="file-tree-empty" role="status">正在查找文件…</div>
      : searchError ? <div className="file-tree-empty" role="alert">{searchError}</div>
      : results.length ? <>{results.map((match) => row(asEntry(match), 0, false, () => onOpen(asEntry(match)), undefined, match.path.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").replace(/\/+$/, "").length + 1)))}
        {results.length >= 20 && <div className="file-tree-empty">显示前 20 项，请缩小关键词范围</div>}</>
      : <div className="file-tree-empty">没有匹配的文件</div>;
  } else content = root ? tree.has(root) ? tree.get(root)!.length ? directories(root, 0) : <div className="file-tree-empty">这个目录为空</div>
    : <div className="file-tree-empty" role="status">正在读取目录…</div>
    : <div className="file-tree-empty">先选择一个工作目录</div>;

  return <div role="tree" aria-label={changes ? "变更文件" : "工作区文件"} className="file-tree" onKeyDown={(event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
    const current = rows.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  }}>{content}</div>;
}

export function FileStatusBadge({ entry }: { entry: GitEntry | null }) {
  const letter = statusLetter(entry);
  if (!entry || !letter) return null;
  return <span className="file-status mono" title={entry.renamedFrom ? `原名 ${entry.renamedFrom}` : entry.conflicted ? "存在冲突" : entry.untracked ? "未跟踪" : "文件有改动"}>
    {entry.binary ? <small>bin</small> : <>{!!entry.added && <small className="text-[var(--diff-add-text)]">+{entry.added}</small>}{!!entry.removed && <small className="text-[var(--diff-del-text)]">−{entry.removed}</small>}</>}
    <span className={statusColor(letter)}>{letter}</span>
  </span>;
}

function DirectoryBadge({ index, path }: { index: StatusIndex; path: string }) {
  if (statusOf(index, path)?.untracked) return <span className="file-status mono" title="未跟踪目录">?</span>;
  const count = index.dirs.get(pathKey(path))?.count ?? 0;
  return count > 0 ? <span className="file-directory-dot" title={`${count} 处改动`}>●</span> : null;
}
