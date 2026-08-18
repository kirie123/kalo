import { useState } from "react";
import type { ChangedFile } from "../lib/changed-files";
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

function FileRow({ file, onOpen }: { file: ChangedFile; onOpen: () => void }) {
  const title = [
    file.fullPath,
    file.created ? "本轮新建" : null,
    file.edits > 1 ? `本轮改动 ${file.edits} 次` : null,
    "点击查看",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      onClick={onOpen}
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
 * End-of-run summary: which files this turn touched, and by how much.
 * The tool groups above show the process; this shows the result.
 */
export default function ChangedFilesCard({
  files,
  totalAdded,
  totalRemoved,
}: {
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}) {
  const [open, setOpen] = useState(true);
  const [viewing, setViewing] = useState<ChangedFile | null>(null);
  return (
    <div className="my-1 rounded-lg border border-edge bg-card text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-base"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
          <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
          <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
        </svg>
        <span className="text-ink">编辑了 {files.length} 个文件</span>
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
      {open && (
        <div className="border-t border-edge px-0.5 py-1">
          {files.map((f) => (
            <FileRow key={f.path} file={f} onOpen={() => setViewing(f)} />
          ))}
        </div>
      )}
      {viewing && <FileViewerModal file={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
