/**
 * AskUserPanel — the input-area takeover for `ask_user` exchanges.
 *
 * The engine submits a batch of structured questions as one `ask_user` tool
 * call. This panel blocks the normal compose area until every question has been
 * answered or skipped, or the user chooses "我直接说" to dismiss without
 * answering (which tells the model to stop and wait rather than re-ask).
 *
 * State machine and answer encoding live in lib/ask-user.ts so they are
 * testable without a DOM. This component only drives that machine and calls
 * back into chat-store.
 *
 * Layout notes (2026-10-01 feedback):
 * - It is a compact card aligned with the composer column, not a full-width
 *   strip — the strip read as a huge block that hid the transcript.
 * - Clicking the header row collapses it to a single line (question snippet +
 *   progress) so the transcript stays readable while deliberating; a new
 *   request always starts expanded.
 * - Opening "其他…" adds the free-text field *below* the option list instead of
 *   replacing it: the options are the answer key, losing sight of them mid-typing
 *   was the bug.
 *
 * Design: doc/2026-09-07-ask-user-向用户提问工具.md
 */

import { type KeyboardEvent, useRef, useState } from "react";
import {
  canSubmit,
  createAskState,
  currentDraft,
  currentQuestion,
  goNext,
  goTo,
  hasOptions,
  isAnswered,
  isLast,
  setCustom,
  setCustomOpen,
  skipCurrent,
  toggleOption,
  type AskState,
} from "../lib/ask-user";
import { chatStore, useChatSelector } from "../lib/chat-store";
import type { AskUserQuestion } from "../types";

function ProgressDots({
  state,
  onGoTo,
}: {
  state: AskState;
  onGoTo: (index: number) => void;
}) {
  if (state.questions.length <= 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {state.questions.map((question, i) => {
        const draft = state.drafts[i];
        const answered = draft !== undefined && isAnswered(question, draft);
        const active = i === state.index;
        return (
          <button
            key={question.id}
            type="button"
            onClick={() => onGoTo(i)}
            aria-label={`第 ${i + 1} 问${answered ? "（已答）" : ""}`}
            aria-current={active ? "step" : undefined}
            className={`h-2 rounded-full transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active
                ? "w-6 bg-accent"
                : answered
                  ? "w-2 bg-accent/50"
                  : "w-2 bg-edge hover:bg-dim"
            }`}
          />
        );
      })}
      <span className="ml-1 text-xs text-dim">
        {state.index + 1}/{state.questions.length}
      </span>
    </div>
  );
}

function OptionList({
  question,
  state,
  onToggle,
  onCustomOpen,
}: {
  question: AskUserQuestion;
  state: AskState;
  onToggle: (label: string) => void;
  onCustomOpen: () => void;
}) {
  const draft = currentDraft(state);
  const options = question.options ?? [];

  return (
    <div className="flex flex-col gap-1">
      {options.map((option) => {
        const selected = draft.selected.includes(option.label);
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onToggle(option.label)}
            className={`flex w-full items-start rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              selected
                ? "border-accent bg-accent/10 text-body"
                : "border-edge bg-raised hover:border-dim hover:bg-base"
            }`}
          >
            <span
              className={`mr-2 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                selected ? "border-accent bg-accent text-white" : "border-dim"
              } ${question.multiSelect ? "rounded" : "rounded-full"}`}
            >
              {selected && "✓"}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="font-medium leading-snug">{option.label}</span>
              {option.description && (
                <span className="mt-px line-clamp-2 text-xs leading-snug text-dim" title={option.description}>
                  {option.description}
                </span>
              )}
            </span>
          </button>
        );
      })}

      {/* "其他…" expander — hidden while the free-text field below is open. */}
      {!draft.customOpen && (
        <button
          type="button"
          onClick={onCustomOpen}
          className="flex w-full items-center rounded-md border border-dashed border-edge px-2.5 py-1.5 text-left text-sm text-dim transition-colors duration-100 hover:border-dim hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          其他…
        </button>
      )}
    </div>
  );
}

function CustomField({
  value,
  onChange,
  onSubmit,
  placeholder = "输入你的答案…",
}: {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition in progress: do not submit on Enter
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <textarea
      ref={ref}
      autoFocus
      rows={3}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKey}
      placeholder={placeholder}
      className="w-full resize-none rounded-lg border border-edge bg-base px-3 py-2 text-sm outline-none transition-colors focus:border-accent"
    />
  );
}

export default function AskUserPanel() {
  const pendingAsk = useChatSelector((s) => s.pendingAsk);
  const [localState, setLocalState] = useState<AskState | null>(null);
  // Collapsed request id, not a boolean: a new ask (new id) must start
  // expanded even if the previous one was left folded.
  const [collapsedId, setCollapsedId] = useState<string | null>(null);

  // Sync local state when a new request arrives; keep editing if the same one.
  const effectiveState =
    pendingAsk !== undefined
      ? localState?.id === pendingAsk.id
        ? localState
        : createAskState(pendingAsk.id, pendingAsk.questions)
      : null;

  if (!effectiveState) return null;

  const question = currentQuestion(effectiveState);
  if (!question) return null;

  const draft = currentDraft(effectiveState);
  const freeTextOnly = !hasOptions(question);
  const answered = isAnswered(question, draft);
  const last = isLast(effectiveState);
  const submittable = canSubmit(effectiveState);
  const collapsed = collapsedId === effectiveState.id;

  const update = (next: AskState) => {
    setLocalState(next);
  };

  const handleNext = () => {
    if (last) {
      void chatStore.submitAsk(effectiveState);
    } else {
      update(goNext(effectiveState));
    }
  };

  return (
    // Compact card sized like the todo panel, pinned above the composer.
    <div className="mx-auto mb-1.5 w-full max-w-lg overflow-hidden rounded-lg border border-edge bg-card text-[13px]">
      {/* Header — always visible, clicking it folds/unfolds the card. When
          folded it keeps the question visible on one line, because that line is
          what the user needs while reading the transcript above. */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsedId(collapsed ? null : effectiveState.id)}
          aria-expanded={!collapsed}
          title={collapsed ? "展开回答" : "折叠（先看上文）"}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left"
        >
          {/* Up when collapsed (the card unfolds upward), down when expanded. */}
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`shrink-0 text-dim transition-transform ${collapsed ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-dim">
            {question.header ?? "提问"}
          </span>
          {collapsed && (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-body">{question.question}</span>
          )}
        </button>
        <ProgressDots
          state={effectiveState}
          onGoTo={(i) => update(goTo(effectiveState, i))}
        />
      </div>

      {!collapsed && (
        <div className="border-t border-edge px-2.5 pb-2.5 pt-2">
          {/* The question is the only free-text slot; it may carry a second
              line when the engine folded a legacy `detail` into it, so it
              wraps on newlines. */}
          <p className="whitespace-pre-wrap text-sm font-medium leading-snug text-body">
            {question.question}
          </p>

          {/* Answer area: only the option list scrolls; the free-text field is
              rendered outside of it so opening "其他…" is always visible. */}
          <div className="mt-2">
            {!freeTextOnly && (
              <div className="max-h-48 overflow-y-auto">
                <OptionList
                  question={question}
                  state={effectiveState}
                  onToggle={(label) => update(toggleOption(effectiveState, label))}
                  onCustomOpen={() => update(setCustomOpen(effectiveState, true))}
                />
              </div>
            )}
            {(freeTextOnly || draft.customOpen) && (
              <div className={freeTextOnly ? "" : "mt-1.5"}>
                <CustomField
                  key={question.id}
                  value={draft.custom}
                  onChange={(text) => update(setCustom(effectiveState, text))}
                  onSubmit={handleNext}
                  placeholder={freeTextOnly ? "输入你的答案…" : "输入其他答案…"}
                />
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* "我直接说" — dismiss without answering */}
              <button
                type="button"
                onClick={() => void chatStore.cancelAsk()}
                className="rounded px-1.5 py-1 text-xs text-dim transition-colors hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                我直接说
              </button>
              {/* Skip current question */}
              {!last && (
                <button
                  type="button"
                  onClick={() => update(skipCurrent(effectiveState))}
                  className="rounded px-1.5 py-1 text-xs text-dim transition-colors hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  跳过本问
                </button>
              )}
            </div>

            <button
              type="button"
              disabled={last ? !submittable : !answered}
              onClick={handleNext}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {last ? "提交" : "下一问"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}