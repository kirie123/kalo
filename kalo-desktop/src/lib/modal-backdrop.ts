/**
 * Shared overlay behaviour for the *form* dialogs: ProviderEditModal,
 * NewProjectModal, TaskEditModal, SkillEditModal, MemoryEditModal and the MCP
 * server editor.
 *
 * Pressing the backdrop must not close them. They hold typed-in work (base URL,
 * API key, model list, schedule spec, skill markdown) and losing it to a stray
 * click costs far more than the convenience of "click outside to dismiss" —
 * 「取消」 and 「保存」 are the exits, one click away.
 *
 * The press is recognised with `onMouseDown` rather than `onClick`, because a
 * click's target is the nearest common ancestor of its press and release: a drag
 * that starts inside the dialog — selecting text, pulling a textarea's resize
 * grip — and ends on the backdrop is reported as a click *on the backdrop*. That
 * is exactly how a half-typed provider config used to vanish without a word.
 */

import { useRef } from "react";
import type { MouseEvent } from "react";
import { chatStore } from "./chat-store";

/** Primary button, pressed on the backdrop itself (not on any of its children). */
export function isBackdropPress(e: {
  button: number;
  target: unknown;
  currentTarget: unknown;
}): boolean {
  return e.button === 0 && e.target === e.currentTarget;
}

/**
 * Spread onto the fixed overlay. The dialog stays open; the first stray press
 * says why, once — swallowing it silently reads as "the app is stuck".
 */
export function usePinnedBackdrop(hint: string) {
  const hinted = useRef(false);
  return {
    onMouseDown: (e: MouseEvent) => {
      if (!isBackdropPress(e)) return;
      if (hinted.current) return;
      hinted.current = true;
      chatStore.pushToast(hint, "info");
    },
  };
}