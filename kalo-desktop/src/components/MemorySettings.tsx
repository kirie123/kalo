import { useCallback, useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { deleteMemory, listMemories } from "../lib/pi-bridge";
import type { MemoryMeta } from "../types";
import MemoryEditModal from "./MemoryEditModal";
import { Section } from "./SettingsPage";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settings section managing ~/.kalo/agent/memory (list / create / edit / delete). */
export default function MemorySettings() {
  const [memories, setMemories] = useState<MemoryMeta[] | null>(null);
  /** undefined = closed, null = creating, MemoryMeta = editing. */
  const [editing, setEditing] = useState<MemoryMeta | null | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setMemories(await listMemories());
    } catch (err) {
      chatStore.pushToast(`加载记忆失败：${errText(err)}`, "error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (m: MemoryMeta) => {
    if (!window.confirm(`确定删除记忆「${m.title}」？该操作不可恢复。`)) return;
    try {
      await deleteMemory(m.slug);
      chatStore.pushToast(`已删除 ${m.title}`, "info");
      void reload();
    } catch (err) {
      chatStore.pushToast(`删除失败：${errText(err)}`, "error");
    }
  };

  return (
    <Section title="记忆">
      {memories === null ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : memories.length === 0 ? (
        <p className="mb-2 text-xs text-dim">
          暂无记忆。对话中告诉 Kalo「记住……」或发送 <code className="md-inline-code">/remember</code> 即可沉淀；
          记忆索引会自动注入每轮对话的系统提示。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {memories.map((m) => (
            <div key={m.slug} className="flex items-center gap-2 rounded-md border border-edge bg-base px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{m.title}</span>
                  {m.tags.map((t) => (
                    <span key={t} className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">
                      {t}
                    </span>
                  ))}
                </div>
                {m.summary && <div className="truncate text-xs text-dim">{m.summary}</div>}
              </div>
              <span className="mono shrink-0 text-[10px] text-dim">{m.updated.slice(0, 10)}</span>
              <button
                onClick={() => setEditing(m)}
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
              >
                编辑
              </button>
              <button
                onClick={() => void remove(m)}
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setEditing(null)}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
        新建记忆
      </button>

      <p className="mt-3 text-xs leading-relaxed text-dim">
        记忆保存在 <code className="md-inline-code">~/.kalo/memory/</code>
        ，对新开的对话生效；当前进行中的对话会在下一轮提问时看到最新索引。
      </p>

      {editing !== undefined && (
        <MemoryEditModal
          memory={editing ?? undefined}
          onClose={(saved) => {
            setEditing(undefined);
            if (saved) void reload();
          }}
        />
      )}
    </Section>
  );
}
