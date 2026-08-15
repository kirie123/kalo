import { useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { readMemory, writeMemory } from "../lib/pi-bridge";
import type { MemoryMeta } from "../types";

interface Props {
  /** Given when editing an existing memory; undefined for "new memory". */
  memory?: MemoryMeta;
  onClose: (saved: boolean) => void;
}

/** Editor for one memory entry: title + tags + body, saved via write_memory. */
export default function MemoryEditModal({ memory, onClose }: Props) {
  const [title, setTitle] = useState(memory?.title ?? "");
  const [tags, setTags] = useState(memory?.tags.join(", ") ?? "");
  const [content, setContent] = useState<string | null>(memory ? null : "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!memory) return;
    let cancelled = false;
    readMemory(memory.slug)
      .then((entry) => {
        if (cancelled) return;
        setTitle(entry.title);
        setTags(entry.tags.join(", "));
        setContent(entry.content);
      })
      .catch((err) => {
        chatStore.pushToast(
          `读取记忆失败：${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        if (!cancelled) onClose(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory?.slug]);

  const save = async () => {
    if (content === null || saving) return;
    if (!title.trim()) {
      chatStore.pushToast("标题不能为空", "warning");
      return;
    }
    if (!content.trim()) {
      chatStore.pushToast("正文不能为空", "warning");
      return;
    }
    setSaving(true);
    try {
      const tagList = tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
      await writeMemory(memory?.slug, title.trim(), tagList, content);
      chatStore.pushToast("记忆已保存", "info");
      onClose(true);
    } catch (err) {
      chatStore.pushToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => onClose(false)}>
      <div
        className="flex max-h-[85vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-edge bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-semibold">{memory ? "编辑记忆" : "新建记忆"}</h3>

        {content === null ? (
          <div className="py-8 text-center text-sm text-dim">加载中…</div>
        ) : (
          <>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="标题（如：我的阅读习惯）"
              className="mb-2 w-full rounded-md border border-edge bg-base px-3 py-1.5 text-sm outline-none focus:border-dim"
            />
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="标签，逗号分隔（如：preference, reading）"
              className="mono mb-2 w-full rounded-md border border-edge bg-base px-3 py-1.5 text-xs outline-none focus:border-dim"
            />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={"正文。第一行会作为摘要显示在记忆索引里。"}
              spellCheck={false}
              className="min-h-0 w-full flex-1 resize-none rounded-md border border-edge bg-base p-3 text-sm leading-relaxed outline-none focus:border-dim"
            />
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={content === null || saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
