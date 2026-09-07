/**
 * Pure dispatcher for engine extension-UI request frames.
 *
 * Extracted from chat-store.ts to keep that file's counted-line count within
 * the ratchet baseline. The callbacks thread just enough store context through
 * without coupling to the ChatStore class directly.
 */

import { createAskState, type AskState } from "./ask-user";
import type { RpcExtensionUIRequest } from "../types";

/** One queued extension UI prompt (select / confirm / input / editor). */
export interface ExtUiPrompt {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export type ExtUiSetters = {
  setPendingAsk(state: ReturnType<typeof createAskState>): void;
  setExtensionQueue(queue: ExtUiPrompt[]): void;
  currentQueue(): ExtUiPrompt[];
  setInputDraft(text: string): void;
};

export function dispatchExtensionUiRequest(
  req: RpcExtensionUIRequest,
  setters: ExtUiSetters,
  isBackground: boolean,
  toast: (msg: string, kind: "info" | "warning" | "error") => void,
): void {
  switch (req.method) {
    case "ask_user":
      setters.setPendingAsk(createAskState(req.id, req.questions));
      if (isBackground) toast("后台会话在等你回答问题，请切换到该会话处理", "info");
      break;
    case "select":
    case "confirm":
    case "input":
    case "editor": {
      const prompt: ExtUiPrompt = {
        id: req.id,
        method: req.method,
        title: req.title,
        message: req.method === "confirm" ? req.message : undefined,
        options: req.method === "select" ? req.options : undefined,
        placeholder: req.method === "input" ? req.placeholder : undefined,
        prefill: req.method === "editor" ? req.prefill : undefined,
      };
      setters.setExtensionQueue([...setters.currentQueue(), prompt]);
      if (isBackground) toast(`后台会话正在等待交互输入（${prompt.title}），请切换到该会话处理`, "info");
      break;
    }
    case "notify":
      toast(req.message, req.notifyType ?? "info");
      break;
    case "setTitle":
      document.title = req.title || "Kalo";
      break;
    case "set_editor_text":
      setters.setInputDraft(req.text);
      break;
    case "setStatus":
    case "setWidget":
      break;
  }
}
