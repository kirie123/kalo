/**
 * WidgetCard — timeline card for one show_widget call.
 * Renders WidgetSandboxFrame for completed widgets and a loading animation
 * for in-progress ones (while the tool call is still running).
 */
import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { WidgetSummary } from "../lib/widgets";
import { chatStore } from "../lib/chat-store";
import { writeFileBytes, writeFileText } from "../lib/pi-bridge";
import ContextMenu, { useContextMenu, type MenuItem } from "./ContextMenu";
import WidgetSandboxFrame, { type WidgetFrameHandle } from "./WidgetSandboxFrame";

/** Title → safe file stem for the save dialog; falls back to "widget". */
function fileStem(title: string): string {
  const cleaned = title.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
  return cleaned.slice(0, 60) || "widget";
}

/** Collapsible header with title, expand/collapse chevron and the "..." menu. */
function WidgetHeader({
  title,
  open,
  onToggle,
  onMenu,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  onMenu: (el: HTMLElement) => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5">
      <button onClick={onToggle} className="flex flex-1 items-center gap-2 text-left">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-tone-violet">
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <path d="M5 8h6M8 5v6" strokeLinecap="round" />
        </svg>
        <span className="font-medium text-ink">{title || "可视化"}</span>
      </button>
      <button
        onClick={(e) => onMenu(e.currentTarget)}
        title="更多操作"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim hover:bg-base hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" />
        </svg>
      </button>
      <button onClick={onToggle} title={open ? "收起" : "展开"} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim hover:bg-base">
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={`transition-transform ${open ? "" : "-rotate-90"}`}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** Shown when the tool call is still running (widget_code not yet available). */
function WidgetLoading({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-4 text-xs text-dim">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" strokeWidth="2" className="shrink-0 animate-spin">
        <circle cx="8" cy="8" r="6" stroke="currentColor" opacity="0.2" />
        <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeLinecap="round" />
      </svg>
      {message}
    </div>
  );
}

/**
 * The inline card rendered in the timeline for one show_widget call.
 * `isStreaming` is true while the parent tool call is still running.
 */
export default function WidgetCard({
  summary,
  isStreaming = false,
}: {
  summary: WidgetSummary;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const messages = summary.loading_messages.length > 0 ? summary.loading_messages : ["正在准备可视化…"];
  const [msgIdx] = useState(0);
  const frameRef = useRef<WidgetFrameHandle>(null);
  const menu = useContextMenu();

  const stem = fileStem(summary.title);
  const isSvg = summary.render_mode === "svg";

  const download = () => {
    void (async () => {
      try {
        const ext = isSvg ? "svg" : "html";
        const path = await save({
          defaultPath: `${stem}.${ext}`,
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });
        if (!path) return;
        await writeFileText(path, summary.widget_code);
        chatStore.pushToast(`已保存到 ${path}`, "info");
      } catch (err) {
        chatStore.pushToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    })();
  };

  const saveImage = () => {
    void (async () => {
      try {
        const dataUrl = await frameRef.current?.capture();
        if (!dataUrl) {
          chatStore.pushToast("无法生成图片", "warning");
          return;
        }
        const path = await save({
          defaultPath: `${stem}.png`,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (!path) return;
        await writeFileBytes(path, dataUrl.replace(/^data:image\/png;base64,/, ""));
        chatStore.pushToast(`已保存到 ${path}`, "info");
      } catch (err) {
        chatStore.pushToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    })();
  };

  const copyCode = () => {
    void navigator.clipboard.writeText(summary.widget_code).then(
      () => chatStore.pushToast("代码已复制", "info"),
      () => chatStore.pushToast("复制失败", "warning"),
    );
  };

  const canRender = !(isStreaming && !summary.widget_code);
  const items: MenuItem[] = [
    { label: "另存为…", action: download },
    ...(canRender && !isSvg ? [{ label: "保存为图片", action: saveImage }] : []),
    { label: "复制代码", action: copyCode },
  ];

  return (
    <div className="my-1 rounded-lg border border-edge bg-card text-[13px]">
      <WidgetHeader
        title={summary.title}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        onMenu={(el) => menu.openAtRect(el)}
      />
      {open && (
        <div className="border-t border-edge">
          {canRender ? (
            <WidgetSandboxFrame ref={frameRef} summary={summary} isStreaming={isStreaming} />
          ) : (
            <WidgetLoading message={messages[msgIdx]} />
          )}
        </div>
      )}
      {menu.at && <ContextMenu at={menu.at} items={items} onClose={menu.close} />}
    </div>
  );
}
