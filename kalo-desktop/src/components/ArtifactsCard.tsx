import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { formatBytes, type FileKind } from "../lib/file-kind";
import type { ArtifactItem } from "../lib/artifacts";
import type { ArtifactSummary } from "../lib/artifacts";
import { chatStore } from "../lib/chat-store";
import { openPath } from "../lib/pi-bridge";
import ContextMenu, { copyPathItem, openPathItem, useContextMenu, type MenuItem } from "./ContextMenu";
import FileViewerModal from "./FileViewerModal";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Color class for a fileKind icon. */
function kindColor(kind: FileKind | undefined): string {
  switch (kind) {
    case "html":     return "text-tone-orange";
    case "markdown": return "text-tone-blue";
    case "image":    return "text-tone-violet";
    case "pdf":      return "text-tone-pink";
    case "svg":      return "text-tone-green";
    default:         return "text-dim";
  }
}

/** Icon for one artifact row: globe for URLs, type-aware icon for local files. */
function ArtifactIcon({ item }: { item: ArtifactItem }) {
  if (item.kind === "url") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-tone-blue">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 1.5c-1.5 1.5-2.5 3.8-2.5 6.5s1 5 2.5 6.5M8 1.5c1.5 1.5 2.5 3.8 2.5 6.5s-1 5-2.5 6.5M1.5 8h13" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`shrink-0 ${kindColor(item.fileKind)}`}>
      <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
    </svg>
  );
}

function ArtifactRow({
  item,
  onOpen,
  onContextMenu,
}: {
  item: ArtifactItem;
  onOpen: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const subtitle = item.bytes !== undefined ? formatBytes(item.bytes) : null;
  return (
    <button
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={item.path}
      disabled={item.missing === true}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-base disabled:cursor-default disabled:opacity-50"
    >
      <ArtifactIcon item={item} />
      <span className={`mono min-w-0 flex-1 truncate text-xs ${item.primary ? "font-medium text-ink" : "text-dim"}`}>
        {item.name}
      </span>
      {item.primary && !item.missing && (
        <span className="shrink-0 text-[10px] text-tone-orange">主</span>
      )}
      {item.missing && <span className="shrink-0 text-[10px] text-dim">缺失</span>}
      {subtitle && !item.missing && !item.primary && (
        <span className="shrink-0 text-[10px] text-dim">{subtitle}</span>
      )}
      {subtitle && !item.missing && item.primary && (
        <span className="shrink-0 text-[10px] text-dim">{subtitle}</span>
      )}
    </button>
  );
}

/** The inline card rendered in the timeline for one present_files call. */
export default function ArtifactsCard({ summary }: { summary: ArtifactSummary }) {
  const [open, setOpen] = useState(true);
  const [viewing, setViewing] = useState<ArtifactItem | null>(null);
  const [menuItem, setMenuItem] = useState<ArtifactItem | null>(null);
  const menu = useContextMenu();

  const openItem = (item: ArtifactItem) => {
    if (item.missing) return;
    if (item.kind === "url") {
      void openPath(item.path).catch((e) => chatStore.pushToast(`打开链接失败：${errText(e)}`, "error"));
      return;
    }
    setViewing(item);
  };

  const menuItems = (item: ArtifactItem): MenuItem[] => {
    if (item.kind === "url") {
      return [
        { label: "在系统浏览器打开", action: () => void openPath(item.path).catch(() => undefined) },
        { label: "复制链接", action: () => void navigator.clipboard.writeText(item.path) },
      ];
    }
    return [
      openPathItem("用默认程序打开", item.path),
      openPathItem("打开所在文件夹", item.path, true),
      copyPathItem(item.path),
      { label: "添加到对话区", action: () => void chatStore.addAttachments([item.path]) },
    ];
  };

  return (
    <div className="my-1 rounded-lg border border-edge bg-card text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-base"
      >
        {/* Deliverables box icon */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-tone-orange">
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <path d="M5 8l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-medium text-ink">产物 {summary.items.length} 个</span>
        {summary.explanation && (
          <span className="min-w-0 flex-1 truncate text-xs text-dim">{summary.explanation}</span>
        )}
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={`shrink-0 text-dim transition-transform ${open ? "" : "-rotate-90"}`}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-edge px-0.5 py-1">
          {summary.items.map((item) => (
            <ArtifactRow
              key={item.path}
              item={item}
              onOpen={() => openItem(item)}
              onContextMenu={(e) => {
                setMenuItem(item);
                menu.onContextMenu(e);
              }}
            />
          ))}
        </div>
      )}
      {menu.at && menuItem && <ContextMenu at={menu.at} items={menuItems(menuItem)} onClose={menu.close} />}
      {viewing && viewing.kind === "file" && (
        <FileViewerModal
          file={{
            path: viewing.name,
            fullPath: viewing.path,
            added: 0,
            edits: 1,
            created: false,
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
