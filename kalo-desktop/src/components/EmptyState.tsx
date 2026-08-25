import { type ReactNode } from "react";
import { useChatZoom } from "../lib/chat-zoom";
import { chatStore } from "../lib/chat-store";
import { QUICK_ACTIONS, type QuickActionIcon, type QuickActionTone } from "../lib/quick-actions";
import InputBox from "./InputBox";

/** Tone → icon classes. Written out literally so Tailwind's scanner sees them
 *  (a template string like `bg-tone-${tone}-soft` would never be generated). */
const TONE_CLASS: Record<QuickActionTone, string> = {
  blue: "bg-tone-blue-soft text-tone-blue",
  green: "bg-tone-green-soft text-tone-green",
  orange: "bg-tone-orange-soft text-tone-orange",
  violet: "bg-tone-violet-soft text-tone-violet",
  pink: "bg-tone-pink-soft text-tone-pink",
};

/** 16px stroked glyphs, keyed by `QuickAction.icon`. */
const ICONS: Record<QuickActionIcon, ReactNode> = {
  trend: (
    <>
      <path d="M2 11.5l3.5-3.5 2.5 2.5L14 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 4.5H14V8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  report: (
    <>
      <path d="M4 2h5l3.5 3.5V14a1 1 0 01-1 1h-7a1 1 0 01-1-1V3a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M9 2v3.5h3.5" strokeLinejoin="round" />
      <path d="M6 11.5v-2M8 11.5v-3.5M10 11.5v-1" strokeLinecap="round" />
    </>
  ),
  paper: (
    <>
      <path d="M3 3.5h7a2 2 0 012 2V14H5a2 2 0 01-2-2V3.5z" strokeLinejoin="round" />
      <path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3" strokeLinecap="round" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </>
  ),
  book: (
    <>
      <path d="M8 4.2S6.8 3 4.6 3H2v9h2.6C6.8 12 8 13 8 13s1.2-1 3.4-1H14V3h-2.6C9.2 3 8 4.2 8 4.2z" strokeLinejoin="round" />
      <path d="M8 4.2V13" />
    </>
  ),
  flask: (
    <>
      <path d="M6.5 2h3v4l3 6a1.5 1.5 0 01-1.3 2.2H4.8A1.5 1.5 0 013.5 12l3-6V2z" strokeLinejoin="round" />
      <path d="M5.5 2h5M4.6 10h6.8" strokeLinecap="round" />
    </>
  ),
};

export default function EmptyState() {
  const zoom = useChatZoom();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4" style={{ zoom }}>
      <h1 className="mb-9 flex items-center gap-3 text-[30px] font-semibold tracking-tight">
        今天想和
        <KaloMark />
        一起完成什么？
      </h1>
      <div className="w-full max-w-3xl">
        <InputBox />
        {/* 只在空会话首屏出现：给第一次用的人几个能直接点的入口。
            填进输入框而不是直接发送——多数场景还要补个代码或链接。 */}
        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => chatStore.setInputDraft(a.prompt)}
              className="group flex items-center gap-2.5 rounded-xl border border-edge bg-elevated px-3.5 py-2.5 text-[13px] text-ink shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-lift"
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${TONE_CLASS[a.tone]}`}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  {ICONS[a.icon]}
                </svg>
              </span>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The greeting's inline avatar: a rounded tile with a minimal robot face.
 * Achromatic on purpose (`bg-ink` + `--accent-contrast`) — colour is reserved
 * for the quick-action icons, so the headline stays calm in both themes.
 */
function KaloMark() {
  return (
    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-ink text-[var(--accent-contrast)]">
      <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="10" cy="2.6" r="1" fill="currentColor" stroke="none" />
        <path d="M10 3.6v1.6" strokeLinecap="round" />
        <rect x="3.7" y="5.2" width="12.6" height="10" rx="3.2" />
        <circle cx="7.6" cy="9.4" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="12.4" cy="9.4" r="1.15" fill="currentColor" stroke="none" />
        <path d="M7.9 12.5h4.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}
