/**
 * Right column: one note, as markdown source or rendered preview.
 *
 * The source textarea is the editor — no rich-text layer, no bidirectional
 * serializer. What the agent writes and what the user edits are the same
 * bytes, which is the whole point of keeping markdown as the source of truth.
 */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeRenderer } from "../../components/AssistantMessage";
import { openPath } from "../../lib/pi-bridge";

export default function NoteEditor({
  relPath,
  absPath,
  text,
  loading,
  dirty,
  saving,
  onChange,
  onSave,
  onDelete,
}: {
  relPath: string;
  /** Absolute path, for 在文件管理器中显示; empty until app_paths resolves. */
  absPath: string;
  text: string;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"source" | "preview">("source");

  // Switching notes lands you back in source view; a preview left over from
  // the previous note reads as if the new one failed to open for editing.
  useEffect(() => setMode("source"), [relPath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2">
        <span className="mono min-w-0 flex-1 truncate text-[11px] text-dim" title={relPath}>
          {relPath}
          {dirty && <span className="text-accent"> ●</span>}
        </span>
        <Toggle active={mode === "source"} onClick={() => setMode("source")} label="源码" />
        <Toggle active={mode === "preview"} onClick={() => setMode("preview")} label="预览" />
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {absPath && (
          <button
            onClick={() => void openPath(absPath, true)}
            title="在文件管理器中显示"
            className="rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
          >
            定位
          </button>
        )}
        <button
          onClick={onDelete}
          className="rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
        >
          删除
        </button>
      </div>

      {loading ? (
        <p className="px-3 py-4 text-xs text-dim">加载中…</p>
      ) : mode === "source" ? (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              onSave();
            }
          }}
          spellCheck={false}
          className="mono min-h-0 flex-1 resize-none bg-base px-3 py-2 text-[13px] leading-relaxed outline-none"
        />
      ) : (
        <div className="markdown min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              code: CodeRenderer as any,
              pre: ({ children }) => <>{children}</>,
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function Toggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs ${
        active ? "border-dim text-ink" : "border-edge text-dim hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
