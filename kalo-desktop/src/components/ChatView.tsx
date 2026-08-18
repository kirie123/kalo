import { useEffect, useRef, useState, type ReactNode } from "react";
import { chatStore, useChatSelector, type ExtensionUiPrompt, type Toast } from "../lib/chat-store";
import { resetChatZoom, stepChatZoom, useChatZoom } from "../lib/chat-zoom";
import InputBox from "./InputBox";
import MessageList from "./MessageList";

export default function ChatView() {
  const zoom = useChatZoom();
  const rootRef = useRef<HTMLDivElement>(null);
  // Transient "120%" badge, shown for a moment after each zoom change.
  const [badge, setBadge] = useState(false);
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Native listener: React's onWheel is passive, so it can't preventDefault
  // (Shift+wheel would otherwise scroll the column sideways).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey && !e.ctrlKey) return;
      // Chromium reports Shift+wheel on deltaX; fall back to it.
      const delta = e.deltaY || e.deltaX;
      if (!delta) return;
      e.preventDefault();
      stepChatZoom(delta < 0 ? 1 : -1);
      setBadge(true);
      if (badgeTimer.current) clearTimeout(badgeTimer.current);
      badgeTimer.current = setTimeout(() => setBadge(false), 1200);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (badgeTimer.current) clearTimeout(badgeTimer.current);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
      <MessageList />
      {/* zoom (not transform) so the composer keeps its normal layout box. */}
      <div className="shrink-0 px-4 pb-4 pt-1" style={{ zoom }}>
        <InputBox />
      </div>

      {badge && (
        <button
          onClick={() => {
            resetChatZoom();
            setBadge(false);
          }}
          title="点击恢复默认大小"
          className="pointer-events-auto absolute right-4 top-3 z-20 rounded-full border border-edge bg-card px-3 py-1 text-xs text-dim shadow-lg hover:text-ink"
        >
          {Math.round(zoom * 100)}%
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Toasts (top-right, auto-dismiss after 3s)
// ============================================================================

export function ToastContainer() {
  const toasts = useChatSelector((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => chatStore.dismissToast(toast.id), 3000);
    return () => clearTimeout(timer);
  }, [toast.id]);

  const border =
    toast.kind === "error"
      ? "border-[var(--error-border)] bg-[var(--error-bg)]"
      : toast.kind === "warning"
        ? "border-[var(--warn-border)] bg-[var(--warn-bg)]"
        : "border-edge bg-card";
  return (
    <div className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg ${border}`}>{toast.message}</div>
  );
}

// ============================================================================
// Extension UI modal (select / confirm / input / editor)
// ============================================================================

export function ExtensionModal() {
  const extensionQueue = useChatSelector((s) => s.extensionQueue);
  const prompt = extensionQueue[0];
  if (!prompt) return null;
  return <ExtensionModalInner key={prompt.id} prompt={prompt} queued={extensionQueue.length - 1} />;
}

function ExtensionModalInner({ prompt, queued }: { prompt: ExtensionUiPrompt; queued: number }) {
  const [value, setValue] = useState(prompt.prefill ?? "");

  const cancel = () => void chatStore.respondExtension(prompt.id, { cancelled: true });
  const submitValue = (v: string) => void chatStore.respondExtension(prompt.id, { value: v });
  const submitConfirmed = (confirmed: boolean) => void chatStore.respondExtension(prompt.id, { confirmed });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={cancel}>
      <div
        className="w-[480px] max-w-[90vw] rounded-xl border border-edge bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-base font-semibold">{prompt.title}</h3>
          {queued > 0 && <span className="text-xs text-dim">还有 {queued} 个请求</span>}
        </div>

        {prompt.method === "confirm" && (
          <>
            <p className="mb-4 whitespace-pre-wrap text-sm text-dim">{prompt.message}</p>
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => submitConfirmed(false)}>否</ModalButton>
              <ModalButton primary onClick={() => submitConfirmed(true)}>
                是
              </ModalButton>
            </div>
          </>
        )}

        {prompt.method === "select" && (
          <div className="mt-2 flex flex-col gap-1">
            {(prompt.options ?? []).map((opt) => (
              <button
                key={opt}
                onClick={() => submitValue(opt)}
                className="rounded-md border border-edge px-3 py-2 text-left text-sm hover:bg-base"
              >
                {opt}
              </button>
            ))}
            <div className="mt-2 flex justify-end">
              <ModalButton onClick={cancel}>取消</ModalButton>
            </div>
          </div>
        )}

        {(prompt.method === "input" || prompt.method === "editor") && (
          <>
            {prompt.method === "editor" ? (
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={10}
                className="mono mt-2 w-full rounded-md border border-edge bg-base p-2 text-sm outline-none focus:border-dim"
              />
            ) : (
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={prompt.placeholder}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitValue(value);
                }}
                className="mt-2 w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
              />
            )}
            <div className="mt-3 flex justify-end gap-2">
              <ModalButton onClick={cancel}>取消</ModalButton>
              <ModalButton primary onClick={() => submitValue(value)}>
                确定
              </ModalButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModalButton({
  children,
  onClick,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm ${
        primary
          ? "bg-accent text-[var(--accent-contrast)] hover:opacity-90"
          : "border border-edge hover:bg-base"
      }`}
    >
      {children}
    </button>
  );
}
