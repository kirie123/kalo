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
 * Design: doc/2026-09-07-ask-user-向用户提问工具.md
 */

import { type KeyboardEvent, useRef, useState } from "react";
import {
  canSubmit,
  createAskState,
  currentDraft,
  currentQuestion,
  encodeAnswers,
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
    <div className="mb-3 flex items-center gap-1.5">
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
    <div className="flex flex-col gap-1.5">
      {options.map((option) => {
        const selected = draft.selected.includes(option.label);
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onToggle(option.label)}
            className={`flex min-h-[44px] w-full items-start rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              selected
                ? "border-accent bg-accent/10 text-body"
                : "border-edge bg-raised hover:border-dim hover:bg-base"
            }`}
          >
            <span
              className={`mr-2.5 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                selected ? "border-accent bg-accent text-white" : "border-dim"
              } ${question.multiSelect ? "rounded" : "rounded-full"}`}
            >
              {selected && "✓"}
            </span>
            <span className="flex flex-col">
              <span className="font-medium leading-snug">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 text-xs text-dim leading-snug">
                  {option.description}
                </span>
              )}
            </span>
          </button>
        );
      })}

      {/* "其他…" expander */}
      {!draft.customOpen && (
        <button
          type="button"
          onClick={onCustomOpen}
          className="flex min-h-[44px] w-full items-center rounded-lg border border-dashed border-edge px-3 py-2 text-left text-sm text-dim transition-colors duration-100 hover:border-dim hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
    <div className="border-t border-edge bg-card px-4 py-3">
      <div className="mx-auto max-w-xl">
        {/* Header */}
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {question.header && (
              <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-dim">
                {question.header}
              </span>
            )}
            <p className="text-sm font-medium leading-snug text-body">
              {question.question}
            </p>
            {question.detail && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-dim leading-relaxed">
                {question.detail}
              </p>
            )}
          </div>
          <ProgressDots state={effectiveState} onGoTo={(i) => update(goTo(effectiveState, i))} />
        </div>

        {/* Answer area — capped height so long option lists don't push everything off screen */}
        <div className="mt-2 max-h-64 overflow-y-auto">
          {freeTextOnly || draft.customOpen ? (
            <CustomField
              value={draft.custom}
              onChange={(text) => update(setCustom(effectiveState, text))}
              onSubmit={handleNext}
              placeholder={freeTextOnly ? "输入你的答案…" : "输入其他答案…"}
            />
          ) : (
            <OptionList
              question={question}
              state={effectiveState}
              onToggle={(label) => update(toggleOption(effectiveState, label))}
              onCustomOpen={() => update(setCustomOpen(effectiveState, true))}
            />
          )}
        </div>

        {/* Footer actions */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {/* "我直接说" — dismiss without answering */}
            <button
              type="button"
              onClick={() => void chatStore.cancelAsk()}
              className="rounded px-2 py-1 text-xs text-dim transition-colors hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              我直接说
            </button>
            {/* Skip current question */}
            {!last && (
              <button
                type="button"
                onClick={() => update(skipCurrent(effectiveState))}
                className="rounded px-2 py-1 text-xs text-dim transition-colors hover:text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
    </div>
  );
}
