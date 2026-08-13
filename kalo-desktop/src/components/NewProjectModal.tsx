import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { chatStore } from "../lib/chat-store";
import { addProject, cwdBasename } from "../lib/projects";

interface Props {
  onClose: (added: boolean) => void;
}

/** Add a project bookmark (name + working directory) to the sidebar. */
export default function NewProjectModal({ onClose }: Props) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");

  const pickDir = async () => {
    try {
      const dir = await open({ directory: true });
      if (typeof dir === "string") {
        setCwd(dir);
        if (!name.trim()) setName(cwdBasename(dir));
      }
    } catch (err) {
      chatStore.pushToast(`选择目录失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const confirm = () => {
    if (!cwd) {
      chatStore.pushToast("请先选择项目目录", "warning");
      return;
    }
    addProject({ name: name.trim() || cwdBasename(cwd), cwd });
    chatStore.pushToast("项目已添加", "info");
    onClose(true);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => onClose(false)}>
      <div
        className="w-[440px] max-w-[92vw] rounded-xl border border-edge bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold">添加项目</h3>

        <div className="mb-3">
          <div className="mb-1 text-xs font-medium text-dim">名称</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="留空则使用目录名"
            autoFocus
            className="w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
          />
        </div>

        <div className="mb-1 text-xs font-medium text-dim">目录</div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void pickDir()}
            className="shrink-0 rounded-md border border-edge px-3 py-2 text-sm text-dim hover:text-ink"
          >
            选择目录…
          </button>
          <span className="mono min-w-0 flex-1 truncate text-xs text-dim" title={cwd}>
            {cwd || "未选择"}
          </span>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            取消
          </button>
          <button
            onClick={confirm}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
