import { useChatZoom } from "../lib/chat-zoom";
import { chatStore } from "../lib/chat-store";
import { QUICK_ACTIONS } from "../lib/quick-actions";
import InputBox from "./InputBox";

export default function EmptyState() {
  const zoom = useChatZoom();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4" style={{ zoom }}>
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">我们该做什么？</h1>
      <div className="w-full max-w-3xl">
        <InputBox />
        {/* 只在空会话首屏出现：给第一次用的人几个能直接点的入口。
            填进输入框而不是直接发送——多数场景还要补个代码或链接。 */}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => chatStore.setInputDraft(a.prompt)}
              className="rounded-full border border-edge bg-card px-3 py-1.5 text-[13px] text-dim transition-colors hover:border-accent hover:text-ink"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
