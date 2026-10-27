import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { formatBytes, type FileKind } from "../lib/file-kind";
import type { ArtifactItem } from "../lib/artifacts";
import { chatStore } from "../lib/chat-store";
import { openPath } from "../lib/pi-bridge";
import { queuePanelArtifactOpen } from "../lib/file-panel-memory";
import { panelTabs } from "../lib/panel-tabs";
import ContextMenu, { copyLinkItem, copyPathItem, openPathItem, openUrlItem, useContextMenu, type MenuItem } from "./ContextMenu";
import DeliveredImage from "./DeliveredImage";

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

/** The deliverables box icon: the artifacts card's header and the run card's
 *  artifacts section share it. */
export function DeliverableIcon({ className = "shrink-0 text-tone-orange" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={className}>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M5 8l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
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
      {subtitle && !item.missing && (
        <span className="shrink-0 text-[10px] text-dim">{subtitle}</span>
      )}
    </button>
  );
}

/**
 * The deliverable rows themselves: local files open in the right panel,
 * URLs use openPath, and right-click offers the path/url menu. Shared by
 * the standalone artifacts card and the end-of-run card, so both behave the
 * same (doc/2026-09-28-产物呈现通道.md § 2026-10-11 增补).
 */
export default function ArtifactList({ items }: { items: ArtifactItem[] }) {
  const [menuItem, setMenuItem] = useState<ArtifactItem | null>(null);
  const menu = useContextMenu();

  const openItem = (item: ArtifactItem) => {
    if (item.missing) return;
    if (item.kind === "url") {
      void openPath(item.path).catch((e) => chatStore.pushToast(`打开链接失败：${errText(e)}`, "error"));
      return;
    }
    const { sessionUid, cwd } = chatStore.getSnapshot();
    queuePanelArtifactOpen(sessionUid, cwd, item);
    panelTabs.showFiles();
  };

  const menuItems = (item: ArtifactItem): MenuItem[] => {
    if (item.kind === "url") {
      return [openUrlItem(item.path), copyLinkItem(item.path)];
    }
    return [
      openPathItem("用默认程序打开", item.path),
      openPathItem("打开所在文件夹", item.path, true),
      copyPathItem(item.path),
      { label: "添加到对话区", action: () => void chatStore.addAttachments([item.path]) },
    ];
  };

  return (
    <>
      {items.map((item) => (
        <div key={item.path}>
          {item.kind === "file" && item.fileKind === "image" && !item.missing && (
            <div className="px-2 py-2"><DeliveredImage source={item.path} alt={item.name} onOpen={() => openItem(item)} /></div>
          )}
          <ArtifactRow
            item={item}
            onOpen={() => openItem(item)}
            onContextMenu={(e) => {
              setMenuItem(item);
              menu.onContextMenu(e);
            }}
          />
        </div>
      ))}
      {menu.at && menuItem && <ContextMenu at={menu.at} items={menuItems(menuItem)} onClose={menu.close} />}
    </>
  );
}
