import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ChangedFile } from "../lib/changed-files";
import { chatStore } from "../lib/chat-store";
import DiffView from "./DiffView";
import FilePreview from "./FilePreview";

type Tab = "diff" | "file";

/**
 * File viewer for one row of the changed-files card: the run's last diff for
 * that file, and the file as it stands now. Portaled to <body> so the chat
 * area's zoom does not shrink a viewport-sized overlay.
 */
export default function FileViewerModal({ file, onClose }: { file: ChangedFile; onClose: () => void }) {
  const [full, setFull] = useState(false);
  const [tab, setTab] = useState<Tab>(file.lastDiff ? "diff" : "file");

  // Esc closes; when full screen, it steps back to the windowed size first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (full) setFull(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex flex-col overflow-hidden rounded-xl border border-edge bg-card shadow-2xl ${
          full ? "h-full w-full" : "max-h-[80vh] w-full max-w-4xl"
        }`}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
          <span className="mono min-w-0 flex-1 truncate text-xs" title={file.fullPath}>
            {file.path}
          </span>

          {file.lastDiff && (
            <div className="flex shrink-0 items-center rounded-md border border-edge text-xs">
              <TabButton active={tab === "diff"} onClick={() => setTab("diff")}>
                改动
              </TabButton>
              <TabButton active={tab === "file"} onClick={() => setTab("file")}>
                全文
              </TabButton>
            </div>
          )}

          <button
            onClick={() => void copyPath(file.fullPath)}
            title="复制路径"
            className="shrink-0 rounded p-1 text-dim hover:bg-base hover:text-ink"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
              <path d="M10.5 3.5v-1a1 1 0 00-1-1h-7a1 1 0 00-1 1v7a1 1 0 001 1h1" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => setFull((v) => !v)}
            title={full ? "退出全屏" : "全屏查看"}
            className="shrink-0 rounded p-1 text-dim hover:bg-base hover:text-ink"
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
          <button onClick={onClose} title="关闭" className="shrink-0 rounded p-1 text-dim hover:bg-base hover:text-ink">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "diff" && file.lastDiff ? (
            <div className="p-3">
              <DiffView diff={file.lastDiff} />
            </div>
          ) : (
            <FilePreview path={file.fullPath} name={file.path} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button onClick={onClick} className={`px-2 py-0.5 ${active ? "bg-base text-ink" : "text-dim hover:text-ink"}`}>
      {children}
    </button>
  );
}

async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    chatStore.pushToast("路径已复制", "info");
  } catch {
    chatStore.pushToast("复制失败", "error");
  }
}
