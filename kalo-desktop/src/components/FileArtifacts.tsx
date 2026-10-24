import type { MouseEvent } from "react";
import type { ArtifactItem } from "../lib/artifacts";
import AppIcon from "./AppIcon";

export default function FileArtifacts({ items, open, onToggle, onOpen, onMenu }: {
  items: ArtifactItem[]; open: boolean; onToggle: () => void;
  onOpen: (item: ArtifactItem) => void; onMenu: (event: MouseEvent, item: ArtifactItem) => void;
}) {
  if (!items.length) return null;
  return <div className="file-artifacts">
    <button className="file-section-heading" aria-expanded={open} onClick={onToggle}><span>{open ? "⌄" : "›"}</span> 对话产物 <small>{items.length}</small></button>
    {open && items.map((item) => <button key={item.path} className="file-tree-row" aria-disabled={item.missing || undefined}
      onClick={() => { if (item.kind === "file" && !item.missing) onOpen(item); }} onContextMenu={(event) => onMenu(event, item)} title={item.path}>
      <AppIcon name={item.kind === "url" ? "inbox" : "file"} size={14} /><span className={`file-tree-name ${item.primary ? "is-primary" : ""}`}>{item.name}</span>
      {item.missing && <small>缺失</small>}
    </button>)}
  </div>;
}
