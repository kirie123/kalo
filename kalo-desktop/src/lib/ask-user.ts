/**
 * The state of one in-progress `ask_user` exchange: which question is showing,
 * what the user has picked so far, and how that becomes the answer batch the
 * engine expects.
 *
 * Pure by design (no IPC, no DOM): the answer encoding is a protocol contract,
 * and the ordering rules ("a single-select choice advances immediately",
 * "skipping keeps earlier drafts") are exactly the kind of thing that breaks
 * silently in a component. AskUserPanel drives these functions and renders the
 * result; chat-store only ships the encoded batch.
 *
 * Design: doc/2026-09-07-ask-user-向用户提问工具.md
 */

import type { AskUserAnswerItem, AskUserQuestion } from "../types";

/** The user's work-in-progress answer to one question. */
export interface AskDraft {
  /** Chosen option labels, in click order. */
  selected: string[];
  /** Free-text answer; "" means the user typed nothing. */
  custom: string;
  /** Whether the free-text field is open (an option list plus "其他…"). */
  customOpen: boolean;
  /** Whether the user explicitly skipped this question. */
  skipped: boolean;
}

/** One ask_user exchange in progress. */
export interface AskState {
  /** The engine-issued request id this exchange answers. */
  id: string;
  questions: AskUserQuestion[];
  /** Index of the question being shown. */
  index: number;
  /** One draft per question, same order. */
  drafts: AskDraft[];
}

function emptyDraft(): AskDraft {
  return { selected: [], custom: "", customOpen: false, skipped: false };
}

/** Start an exchange with every question unanswered and the first one showing. */
export function createAskState(id: string, questions: AskUserQuestion[]): AskState {
  return { id, questions, index: 0, drafts: questions.map(() => emptyDraft()) };
}

/** The question currently being shown. */
export function currentQuestion(state: AskState): AskUserQuestion | undefined {
  return state.questions[state.index];
}

/** The draft for the question currently being shown. */
export function currentDraft(state: AskState): AskDraft {
  return state.drafts[state.index] ?? emptyDraft();
}

/** Whether the shown question offers a menu (as opposed to free text only). */
export function hasOptions(question: AskUserQuestion): boolean {
  return (question.options?.length ?? 0) > 0;
}

function replaceDraft(state: AskState, index: number, draft: AskDraft): AskState {
  const drafts = [...state.drafts];
  drafts[index] = draft;
  return { ...state, drafts };
}

/**
 * Whether one question's draft counts as answered.
 *
 * A skip counts: it is a decision, encoded as an empty selection. This is what
 * lets the user submit a batch where they only cared about question 2.
 */
export function isAnswered(question: AskUserQuestion, draft: AskDraft): boolean {
  if (draft.skipped) return true;
  if (draft.custom.trim() !== "") return true;
  return hasOptions(question) && draft.selected.length > 0;
}

/** Whether the whole batch may be submitted. */
export function canSubmit(state: AskState): boolean {
  return state.questions.every((question, i) => isAnswered(question, state.drafts[i]));
}

/** Advance to the next unanswered question, or stay put when this was the last. */
function advance(state: AskState): AskState {
  const next = state.index + 1;
  return next < state.questions.length ? { ...state, index: next } : state;
}

/**
 * Toggle one option.
 *
 * Single-select replaces the selection, clears any free text (the two are
 * mutually exclusive there), and advances — clicking an option IS the answer,
 * so making the user then press "next" would be a second click for nothing.
 * Multi-select accumulates and stays put, because the user is not done yet.
 */
export function toggleOption(state: AskState, label: string): AskState {
  const question = currentQuestion(state);
  if (!question) return state;
  const draft = currentDraft(state);

  if (question.multiSelect !== true) {
    const picked = replaceDraft(state, state.index, {
      selected: [label],
      custom: "",
      customOpen: false,
      skipped: false,
    });
    return advance(picked);
  }

  const selected = draft.selected.includes(label)
    ? draft.selected.filter((l) => l !== label)
    : [...draft.selected, label];
  return replaceDraft(state, state.index, { ...draft, selected, skipped: false });
}

/**
 * Open or close the free-text field.
 *
 * Opening it on a single-select question clears the selection, since the answer
 * can only be one or the other.
 */
export function setCustomOpen(state: AskState, open: boolean): AskState {
  const question = currentQuestion(state);
  if (!question) return state;
  const draft = currentDraft(state);
  const singleSelect = question.multiSelect !== true;
  return replaceDraft(state, state.index, {
    ...draft,
    customOpen: open,
    custom: open ? draft.custom : "",
    selected: open && singleSelect ? [] : draft.selected,
    skipped: false,
  });
}

/** Type into the free-text field. */
export function setCustom(state: AskState, text: string): AskState {
  const question = currentQuestion(state);
  if (!question) return state;
  const draft = currentDraft(state);
  const singleSelect = question.multiSelect !== true;
  return replaceDraft(state, state.index, {
    ...draft,
    custom: text,
    customOpen: true,
    selected: singleSelect ? [] : draft.selected,
    skipped: false,
  });
}

/**
 * Skip only the question being shown.
 *
 * Earlier answers are kept: a skip is scoped to one question, so it must not
 * behave like cancelling the whole request.
 */
export function skipCurrent(state: AskState): AskState {
  if (!currentQuestion(state)) return state;
  const skipped = replaceDraft(state, state.index, { ...emptyDraft(), skipped: true });
  return advance(skipped);
}

/** Move to a specific question (progress dots, going back to revise). */
export function goTo(state: AskState, index: number): AskState {
  if (index < 0 || index >= state.questions.length) return state;
  return { ...state, index };
}

/** Move to the next question without answering the current one. */
export function goNext(state: AskState): AskState {
  return advance(state);
}

/** Whether the shown question is the last one. */
export function isLast(state: AskState): boolean {
  return state.index === state.questions.length - 1;
}

/**
 * Encode the drafts as the wire answer batch.
 *
 * Order matches the questions because the engine validates positionally: that
 * is what stops "skipped one" from arriving as "answered a different one".
 */
export function encodeAnswers(state: AskState): AskUserAnswerItem[] {
  return state.questions.map((question, i) => {
    const draft = state.drafts[i] ?? emptyDraft();
    const singleSelect = question.multiSelect !== true;
    const custom = draft.custom.trim();
    // Single-select: free text wins over any leftover selection, since the two
    // cannot coexist in the protocol.
    const selected = custom !== "" && singleSelect ? [] : draft.selected;
    return {
      id: question.id,
      selected: [...selected],
      ...(custom === "" ? {} : { custom }),
    };
  });
}

/**
 * Re-check the encoded batch against the same rules the engine enforces.
 *
 * The engine is the authority (a frontend is replaceable, unverified input), but
 * failing there costs the user a whole round trip for nothing, so the same rules
 * run here before sending.
 *
 * @returns Reason the batch would be rejected, or undefined when it is valid.
 */
export function validateEncoded(questions: AskUserQuestion[], answers: AskUserAnswerItem[]): string | undefined {
  if (answers.length !== questions.length) {
    return `期望 ${questions.length} 条答案，实际 ${answers.length} 条`;
  }
  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    if (answer.id !== question.id) return `第 ${index + 1} 条答案的 id 不匹配`;
    if (new Set(answer.selected).size !== answer.selected.length) return `问题 ${question.id} 有重复选项`;
    const labels = new Set((question.options ?? []).map((option) => option.label));
    for (const label of answer.selected) {
      if (!labels.has(label)) return `问题 ${question.id} 有不属于该问的选项：${label}`;
    }
    if (answer.custom !== undefined && answer.custom.trim() === "") return `问题 ${question.id} 的自由文本为空`;
    if (question.multiSelect !== true) {
      if (answer.selected.length > 1) return `问题 ${question.id} 是单选，却有多个选项`;
      if (answer.custom !== undefined && answer.selected.length > 0) {
        return `问题 ${question.id} 是单选，选项与自由文本不能同时给出`;
      }
    }
  }
  return undefined;
}
