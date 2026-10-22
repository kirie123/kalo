/**
 * One open file tab's pane: the 源码/diff row plus the document below it.
 *
 * Split out of FilePanel (tree, git strip, artifacts, context menu) so that
 * panel stays under the file-length budget, and so the fullscreen overlay can
 * reuse exactly the same row. This row is also where a file gets closed: the
 * file tab itself carries no × (doc/2026-10-10-右栏文件页签.md).
 */

import type { FileView, PanelFile } from "../lib/file-panel-memory";
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
}) {
  return (
    <>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-edge px-3">
        <span className="min-w-0 truncate text-xs font-medium">{file.name}</span>
        <div className="flex shrink-0 items-center gap-1">
          {canDiff && (
            <div className="mr-1 flex items-center overflow-hidden rounded-md border border-edge text-[10px]">
              {(["source", "diff"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onView(t)}
                  className={`px-1.5 py-0.5 ${file.view === t ? "bg-card text-ink" : "text-dim hover:text-ink"}`}
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
            与 HEAD 无差异。（未跟踪的新文件没有 diff，切到「源码」看内容。）
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
    </>
  );
}