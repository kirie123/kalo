import { useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { readSkill, writeSkill } from "../lib/pi-bridge";
import type { SkillMeta } from "../types";

interface Props {
  skill: SkillMeta;
  onClose: (saved: boolean) => void;
}

/** Full-text editor for one SKILL.md, loaded via read_skill and saved via write_skill. */
export default function SkillEditModal({ skill, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readSkill(skill.path)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        chatStore.pushToast(
          `读取 Skill 失败：${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        if (!cancelled) onClose(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.path]);

  const save = async () => {
    if (content === null || saving) return;
    setSaving(true);
    try {
      await writeSkill(skill.path, content);
      chatStore.pushToast("Skill 已保存", "info");
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
        <h3 className="mb-1 text-base font-semibold">编辑 Skill：{skill.name}</h3>
        <div className="mono mb-3 truncate text-xs text-dim" title={skill.path}>
          {skill.path}
        </div>

        {content === null ? (
          <div className="py-8 text-center text-sm text-dim">加载中…</div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="mono min-h-0 w-full flex-1 resize-none rounded-md border border-edge bg-base p-3 text-xs leading-relaxed outline-none focus:border-dim"
          />
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
