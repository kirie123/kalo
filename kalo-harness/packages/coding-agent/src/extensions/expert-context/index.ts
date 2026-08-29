/**
 * Expert context extension — digital expert identity injection.
 *
 * When the engine is spawned with KALO_EXPERT_ID set (the desktop does this
 * for sessions that belong to an expert, see doc/2026-08-29-digital-experts.md),
 * inject the expert's identity into the system prompt: who it is, what its
 * mission is, and where its private data lives.
 *
 * Memory isolation itself is handled by the memory extension reading
 * KALO_MEMORY_DIR; this extension only explains the setup to the model.
 * No env vars → no-op, regular sessions are unaffected.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";

export default function expertContextExtension(pi: ExtensionAPI): void {
	const id = process.env.KALO_EXPERT_ID?.trim();
	if (!id) return;
	const name = process.env.KALO_EXPERT_NAME?.trim() || id;
	const mission = process.env.KALO_EXPERT_MISSION?.trim() || "";

	pi.on("before_agent_start", async (event) => {
		const missionBlock = mission ? `\n\n你的使命：${mission}` : "";
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## 数字专家身份\n\n你是数字专家「${name}」（id: ${id}）——一个有独立身份的长期 Agent 实例，不是用户的通用助手。${missionBlock}\n\n` +
				"- 你的工作目录就是你的全部世界：目录形态按你的使命规划，重要产出都沉淀为目录里的文件，跨会话靠文件和记忆延续。\n" +
				"- 你的长期记忆是独立的（memory_save / memory_search / memory_list 只看到你个人的记忆，与用户和其他专家隔离）。\n" +
				"- 你的专属技能在 `<工作目录>/.kalo/skills/` 下；发现可复用的工作方法时，把它写成该目录下的新 skill。\n" +
				"- 工作目录根部的 AGENTS.md 是你的宪章：每次开始工作前先读它；需要调整规则时修改它并说明原因。",
		};
	});
}
