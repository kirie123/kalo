/**
 * One open file tab's pane: navigation, view controls and the document below.
 *
 * Split out of FilePanel (tree, git strip, artifacts, context menu) so that
 * panel stays under the file-length budget, and so the fullscreen overlay can
 * reuse exactly the same row. Both this row and the file tab can close a file.
 */

import { useLayoutEffect, useRef } from "react";
import type { FileView, PanelFile } from "../lib/file-panel-memory";
import { pathBreadcrumbs } from "../lib/file-tree";
import ContextMenu, { copyPathItem, openPathItem, useContextMenu } from "./ContextMenu";
import { chatStore } from "../lib/chat-store";
import DiffView, { type DiffLine } from "./DiffView";
import FilePreview from "./FilePreview";

export default function FilePreviewPane({
  file,
  canDiff,
  diff,
  loading,
  full,
  onView,
  onFull,
  onClose,
  onOpenPath,
  onNavigate,
}: {
  file: PanelFile;
  canDiff: boolean;
  diff: DiffLine[] | null;
  loading: boolean;
  /** Fullscreen overlay: the row offers the way back out instead of fullscreen. */
  full?: boolean;
  onView: (view: FileView) => void;
  onFull: () => void;
  onClose: () => void;
  onOpenPath?: (path: string) => void;
  onNavigate?: (path: string) => void;
}) {
  const menu = useContextMenu();
  const breadcrumb = useRef<HTMLElement>(null);
  const crumbs = pathBreadcrumbs(file.path);
  useLayoutEffect(() => {
    const element = breadcrumb.current;
    if (!element) return;
    const revealFile = () => { element.scrollLeft = element.scrollWidth; };
    revealFile();
    const observer = new ResizeObserver(revealFile);
    observer.observe(element);
    return () => observer.disconnect();
  }, [file.path]);
  return (
    <>
      <div className="file-preview-toolbar">
        <nav className="file-breadcrumbs" aria-label="当前文件路径" ref={breadcrumb}>
          {crumbs.map((crumb, index) => <span key={crumb.path}>{index > 0 && <span className="file-path-separator" aria-hidden="true">›</span>}
            {index === crumbs.length - 1 ? <strong title={file.path} aria-current="page">{crumb.name}</strong>
              : <button title={crumb.path} onClick={() => { onNavigate?.(crumb.path); if (full) onFull(); }}>{crumb.name}</button>}
          </span>)}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {canDiff && (
            <div className="mr-1 flex items-center overflow-hidden rounded-md border border-edge text-[10px]">
              {(["source", "diff"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onView(t)}
                  aria-pressed={file.view === t}
                  className={`px-1.5 py-0.5 ${file.view === t ? "bg-card text-ink" : "text-dim hover:text-ink"}`}
                >
                  {t === "source" ? "内容" : "更改"}
                </button>
              ))}
            </div>
          )}
          <button onClick={(event) => menu.openAtRect(event.currentTarget)} title="文件操作" aria-label="文件操作" className="file-icon-button">···</button>
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
            <button onClick={onFull} title="全屏查看" className="rounded p-1 text-dim hover:bg-card hover:text-ink">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button onClick={onClose} title="关闭这个文件" className="rounded p-1 text-dim hover:bg-card hover:text-ink">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {file.view === "diff" ? (
        loading ? (
          <div className="min-h-0 flex-1 px-3 py-2 text-xs text-dim">读取 diff…</div>
        ) : !diff || diff.length === 0 ? (
          <div className="min-h-0 flex-1 px-3 py-2 text-xs text-dim">
            与 HEAD 无差异。（未跟踪的新文件没有 diff，切到「内容」查看。）
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <DiffView lines={diff} />
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <FilePreview path={file.path} name={file.name} onOpenPath={onOpenPath} />
        </div>
      )}
      {menu.at && <ContextMenu at={menu.at} onClose={menu.close} items={[
        openPathItem("打开文件", file.path), openPathItem("显示文件位置", file.path, true), copyPathItem(file.path),
        { label: "添加到对话区", action: () => void chatStore.addAttachments([file.path]) },
      ]} />}
    </>
  );
}
