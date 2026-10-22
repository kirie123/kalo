import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ArtifactSummary } from "../lib/artifacts";
import type { ChangedFile } from "../lib/changed-files";
import { chatStore } from "../lib/chat-store";
import ArtifactList, { DeliverableIcon } from "./ArtifactList";
import ContextMenu, { copyPathItem, openPathItem, useContextMenu, type MenuItem } from "./ContextMenu";
import FileViewerModal from "./FileViewerModal";

/** "+134 -13", with the dash omitted when the count is unknown. */
function Counts({ added, removed }: { added: number; removed?: number }) {
  return (
    <span className="mono shrink-0 text-xs">
      <span className="text-[var(--diff-add-text)]">+{added}</span>
      {removed !== undefined && <span className="ml-1.5 text-[var(--diff-del-text)]">-{removed}</span>}
    </span>
  );
}

/** Keep the filename visible on a long path by eliding the middle segments. */
function shortenPath(path: string, max = 60): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  if (parts.length < 3) return `…${path.slice(-(max - 1))}`;
  const tail = parts[parts.length - 1];
  const head = parts[0];
  return `${head}/…/${tail}`.length <= max ? `${head}/…/${tail}` : `…/${tail}`;
}

function FileRow({
  file,
  onOpen,
  onContextMenu,
}: {
  file: ChangedFile;
  onOpen: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const title = [
    file.fullPath,
    file.created ? "本轮新建" : null,
    file.edits > 1 ? `本轮改动 ${file.edits} 次` : null,
    "点击查看，右键更多",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={title}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-base"
    >
      <span className="mono min-w-0 flex-1 truncate text-xs text-dim">{shortenPath(file.path)}</span>
      {file.created && <span className="shrink-0 text-[10px] text-dim">新建</span>}
      <Counts added={file.added} removed={file.removed} />
    </button>
  );
}

/**
 * End-of-run summary: which files this turn touched, and by how much — plus the
 * run's present_files deliverables, listed last (the two used to be separate
 * cards; doc/2026-09-28-产物呈现通道.md § 2026-10-11 增补).
 * The first three files and declared deliverables stay visible after completion.
 */
export default function ChangedFilesCard({
  files,
  totalAdded,
  totalRemoved,
  artifacts,
}: {
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
  /** This run's present_files list, attached by foldRunArtifacts. */
  artifacts?: ArtifactSummary;
}) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<ChangedFile | null>(null);
  // Right-click target; the menu itself is anchored by useContextMenu.
  const [menuFile, setMenuFile] = useState<ChangedFile | null>(null);
  const menu = useContextMenu();

  const menuItems = (file: ChangedFile): MenuItem[] => [
    { label: file.lastDiff ? "查看改动" : "查看全文", action: () => setViewing(file) },
    openPathItem("用默认程序打开", file.fullPath),
    openPathItem("打开所在文件夹", file.fullPath, true),
    copyPathItem(file.fullPath),
    { label: "添加到对话区", action: () => void chatStore.addAttachments([file.fullPath]) },
  ];

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-edge bg-base text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-card"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
          <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
          <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
        </svg>
        <span className="font-medium text-ink">已修改 {files.length} 个文件</span>
        {artifacts && (
          <>
            <span className="text-dim">·</span>
            <span className="text-ink">产物 {artifacts.items.length} 个</span>
          </>
        )}
        <span className="flex-1" />
        <Counts added={totalAdded} removed={totalRemoved} />
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`shrink-0 text-dim transition-transform ${open ? "" : "-rotate-90"}`}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
        <div className="border-t border-edge px-2 py-2">
          {(open ? files : files.slice(0, 3)).map((f) => (
            <FileRow
              key={f.path}
              file={f}
              onOpen={() => setViewing(f)}
              onContextMenu={(e) => {
                setMenuFile(f);
                menu.onContextMenu(e);
              }}
            />
          ))}
          {files.length > 3 && (
            <button onClick={() => setOpen((value) => !value)} className="px-2 py-2 text-dim hover:text-ink">
              {open ? "收起文件列表" : `再显示 ${files.length - 3} 个文件`}
            </button>
          )}
          {artifacts && (
            <div className="mt-1 border-t border-edge pt-0.5">
              <div className="flex items-center gap-2 px-2 py-1">
                <DeliverableIcon />
                <span className="shrink-0 text-[11px] text-dim">产物 {artifacts.items.length} 个</span>
                {artifacts.explanation && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{artifacts.explanation}</span>
                )}
              </div>
              <ArtifactList items={artifacts.items} />
            </div>
          )}
        </div>
      {menu.at && menuFile && <ContextMenu at={menu.at} items={menuItems(menuFile)} onClose={menu.close} />}
      {viewing && <FileViewerModal file={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
