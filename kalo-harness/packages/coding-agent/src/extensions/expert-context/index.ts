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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { readExpertPackage, readPackageRole, runtimeAdapter } from "./package.ts";

export default function expertContextExtension(pi: ExtensionAPI): void {
	const id = process.env.KALO_EXPERT_ID?.trim();
	if (!id) return;
	const name = process.env.KALO_EXPERT_NAME?.trim() || id;
	const mission = process.env.KALO_EXPERT_MISSION?.trim() || "";

	pi.on("before_agent_start", async (event, ctx) => {
		const recorded = ctx.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "kalo-expert-context");
		if (recorded?.type === "custom" && (recorded.data as { id?: string })?.id !== id)
			throw new Error("会话专家身份与所选专家不一致，请新建对话后重试");
		if (!recorded) pi.appendEntry("kalo-expert-context", { id });
		const missionBlock = mission ? `\n\n你的使命：${mission}` : "";
		const definitionDir = process.env.KALO_EXPERT_DIR?.trim() || ctx.cwd;
		const pkg = readExpertPackage(definitionDir);
		const role = pkg ? readPackageRole(definitionDir, pkg, pkg.entryAgent) : undefined;
		const charterPath = join(definitionDir, "AGENTS.md");
		const charter =
			!role && definitionDir !== ctx.cwd && existsSync(charterPath) ? readFileSync(charterPath, "utf8") : "";
		const packagePrompt =
			role && pkg
				? `\n\n## 导入角色：${role.name} (${role.id})\n\n${role.body}\n\n角色名单：\n${pkg.members.map((m) => `- ${m.id}：${m.name} / ${m.profession}`).join("\n")}${runtimeAdapter(false, pkg.kind === "team", definitionDir)}`
				: `\n\n${charter}${runtimeAdapter(false, false, definitionDir)}`;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## 数字专家身份\n\n你是数字专家「${name}」（id: ${id}）——一个有独立身份的长期 Agent 实例，不是用户的通用助手。${missionBlock}\n\n` +
				`- 当前任务工作目录为 ${ctx.cwd}，任务产出写在这里；专家定义目录为 ${definitionDir}，负责提供角色与技能。两个目录各自独立。\n` +
				"- 你的长期记忆是独立的（memory_save / memory_search / memory_list 只看到你个人的记忆，与用户和其他专家隔离）。\n" +
				"- 你的专属技能从专家定义目录加载；当前项目的 AGENTS.md 约束当前任务，任务产出和新资料不要写入角色/技能来源目录。" +
				packagePrompt,
		};
	});
}
