interface AnswerRoutes {
  isChat: (sessionId: string) => boolean;
  isScheduled: (sessionId: string) => boolean;
  chatAnswer: (sessionId: string, answer: string) => Promise<void>;
  sendText: (text: string) => Promise<unknown>;
}

/** A scheduled session is not owned by the inbound chat channel. Keep its complete answer. */
export async function deliverGatewayAnswer(sessionId: string, answer: string, routes: AnswerRoutes): Promise<void> {
  if (routes.isChat(sessionId)) { await routes.chatAnswer(sessionId, answer); return; }
  if (!routes.isScheduled(sessionId)) return;
  for (let start = 0; start < answer.length;) {
    let end = Math.min(start + 3000, answer.length);
    if (end < answer.length) {
      const newline = answer.lastIndexOf("\n", end - 1);
      if (newline > start + 1500) end = newline + 1;
      const unit = answer.charCodeAt(end - 1);
      if (unit >= 0xd800 && unit <= 0xdbff) end--;
    }
    await routes.sendText(answer.slice(start, end));
    start = end;
  }
}
