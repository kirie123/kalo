import type { Expert } from "../types";
import { chatStore } from "./chat-store";
import { needsExpertWorkspace } from "./expert-catalog";
import { createWorkspace } from "./pi-bridge";

/** Thin lifecycle adapter: role choice and filesystem choice are independent. */
export async function selectChatExpert(expert: Expert | null, experts: Expert[]): Promise<void> {
  const current = chatStore.state;
  if (current.isStreaming || current.isCompacting || current.connecting) throw new Error("请等待当前任务结束后切换专家");
  if (expert && !expert.enabled) throw new Error("该专家已停用");
  const replaceWorkspace = needsExpertWorkspace(current.cwd, experts);
  if (current.expertId === expert?.id && !replaceWorkspace) return;
  const cwd = replaceWorkspace ? await createWorkspace() : current.cwd;
  const latest = chatStore.state;
  if (latest.sessionUid !== current.sessionUid || latest.cwd !== current.cwd || latest.expertId !== current.expertId) return;
  chatStore.selectExpert(expert?.id, cwd);
  chatStore.pushToast(expert ? `已选择「${expert.name}」` : "已切换为通用助手", "info");
}
