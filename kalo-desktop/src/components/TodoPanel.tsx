import { useState } from "react";
import { useChatSelector, type TodoItem } from "../lib/chat-store";

/**
 * Status glyph shared by the panel and the todo_write tool bubble, so one
 * plan reads the same in both places. Hand-drawn 12px svg to match the rest
 * of the app (no icon library); in_progress reuses the global `.spinner`.
 */
export function TodoStatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "in_progress") return <span className="spinner" style={{ width: 11, height: 11 }} />;
  if (status === "completed") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-[var(--ok)]" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.8 8.2l2.2 2.2 4.2-4.4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-dim" aria-hidden>
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.4 2.4" />
    </svg>
  );
}

/** "2 已完成 · 1 进行中 · 1 待办" — zero-count segments are dropped as noise. */
function progressLabel(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.filter((t) => t.status === "in_progress").length;
  const pending = todos.length - done - active;
  return [
    ...(done > 0 ? [`${done} 已完成`] : []),
    ...(active > 0 ? [`${active} 进行中`] : []),
    ...(pending > 0 ? [`${pending} 待办`] : []),
  ].join(" · ");
}

/**
 * The agent's plan, pinned above the composer. Shows the latest whole-list
 * todo_write snapshot; the store clears it when the next run starts.
 *
 * Collapsed by default but still showing the in-progress task on the header
 * line — that one line is what the user actually wants, and it shouldn't cost
 * a click. Renders nothing when there is no plan.
 */
export default function TodoPanel() {
  const todos = useChatSelector((s) => s.todos);
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;

  const active = todos.find((t) => t.status === "in_progress");

  return (
    <div className="mb-1.5 rounded-lg border border-edge bg-card text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-base"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          className="shrink-0 text-dim"
          aria-hidden
        >
          <path d="M5.5 3.5h7M5.5 8h7M5.5 12.5h7" strokeLinecap="round" />
          <path d="M2.5 3.5l.9.9 1.4-1.6M2.5 8l.9.9 1.4-1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 text-ink">任务清单</span>
        {!open && active && (
          <span className="min-w-0 flex-1 truncate text-xs text-dim">{active.content}</span>
        )}
        <span className={`shrink-0 text-xs text-dim ${open || !active ? "ml-auto" : ""}`}>{progressLabel(todos)}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`shrink-0 text-dim transition-transform ${open ? "" : "-rotate-90"}`}
          aria-hidden
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="flex max-h-52 flex-col gap-1 overflow-y-auto border-t border-edge px-2.5 py-2">
          {todos.map((todo) => (
            <div key={todo.content} className="flex items-start gap-2 text-xs">
              <span className="mt-px shrink-0">
                <TodoStatusIcon status={todo.status} />
              </span>
              <span className={todo.status === "completed" ? "text-dim line-through" : "text-ink"}>{todo.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
