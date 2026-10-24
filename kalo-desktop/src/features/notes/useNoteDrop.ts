import { useEffect, useRef, useState, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { chatStore } from "../../lib/chat-store";

/** Native file drops do not fire DOM drop events in the desktop webview. */
export function useNoteDrop(area: RefObject<HTMLElement>, onPaths: (paths: string[]) => void, disabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const current = useRef({ onPaths, disabled });
  current.current = { onPaths, disabled };
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (!alive) return;
      if (payload.type === "leave") { setDragging(false); return; }
      const box = area.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      const accepted = Boolean(inside && !current.current.disabled);
      setDragging(payload.type !== "drop" && accepted);
      if (payload.type === "drop" && accepted) current.current.onPaths(payload.paths);
    });
    void unlisten.catch((err: unknown) => { if (alive) chatStore.pushToast(`图片拖入暂不可用，请使用插入图片按钮：${String(err)}`, "warning"); });
    return () => { alive = false; void unlisten.then((off) => off()).catch(() => {}); };
  }, [area]);
  return dragging;
}
