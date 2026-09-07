import { chatStore } from "./chat-store";
import { createWorkspace } from "./pi-bridge";

/**
 * Start a chat that carries nothing over from the current one.
 *
 * 「新对话」used to inherit the active session's cwd, which silently ran an
 * unrelated question inside the last project — or, right after an expert
 * session, inside the expert's directory without its identity. So a fresh chat
 * gets a fresh working directory from the backend
 * (`~/.kalo/workspaces/chat-<n>`, see doc/2026-09-07-新对话工作目录.md).
 *
 * Entry points that already know where the chat belongs (a pinned project, an
 * expert's workdir, an era workspace) keep passing their own cwd to
 * `chatStore.newChat` and do not go through here.
 */
export async function startFreshChat(): Promise<void> {
  try {
    const cwd = await createWorkspace();
    chatStore.newChat({ cwd });
  } catch (err) {
    // A「新对话」that does nothing is worse than one in the old directory:
    // fall back to the inherited cwd and say why.
    chatStore.pushToast(
      `没能创建新的工作目录（${err instanceof Error ? err.message : String(err)}），本次沿用当前目录`,
      "warning",
    );
    chatStore.newChat();
  }
}
