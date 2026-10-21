import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

interface Member {
	id: string;
	name: string;
	profession: string;
	agentPath: string;
}

export interface ExpertPackage {
	kind: "agent" | "team";
	entryAgent: string;
	members: Member[];
}

export interface MemberRole {
	id: string;
	name: string;
	body: string;
	definitionDir?: string;
}

export const MEMBER_ROLE_ENTRY = "kalo-expert-member-role";

export function readExpertPackage(cwd: string): ExpertPackage | undefined {
	let text: string;
	try {
		text = readFileSync(join(cwd, ".kalo", "expert.json"), "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(text) as ExpertPackage;
	if (
		!value ||
		(value.kind !== "agent" && value.kind !== "team") ||
		typeof value.entryAgent !== "string" ||
		!Array.isArray(value.members) ||
		!value.members.every(
			(member) =>
				member &&
				typeof member.id === "string" &&
				typeof member.name === "string" &&
				typeof member.agentPath === "string",
		) ||
		!value.members.some((member) => member.id === value.entryAgent)
	) {
		throw new Error("专家包索引无效，请检查工作区 .kalo/expert.json");
	}
	return value;
}

export function readPackageRole(cwd: string, pkg: ExpertPackage, id: string): MemberRole {
	const member = pkg.members.find((member) => member.id === id);
	if (!member) throw new Error(`未知专家团成员：${id}；可选 ${pkg.members.map((m) => m.id).join(", ")}`);
	const path = member.agentPath.replace(/\\/g, "/");
	if (isAbsolute(path) || path.includes(":") || path.split("/").includes("..") || !path.endsWith(".md")) {
		throw new Error(`角色文件路径无效：${path}`);
	}
	const root = realpathSync(cwd);
	const file = realpathSync(resolve(root, path));
	const within = relative(root, file);
	if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
		throw new Error(`角色文件不能越出专家工作区：${path}`);
	}
	const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	if (frontmatter.name !== id || !body.trim()) throw new Error(`角色文件 name 或正文无效：${path}`);
	return { id, name: member.name, body, definitionDir: root };
}

export function resolveMemberRole(cwd: string, id: string, definitionDir = cwd): MemberRole {
	const pkg = readExpertPackage(definitionDir);
	if (!pkg || pkg.kind !== "team") throw new Error("当前工作区没有专家团；普通子 agent 请省略 subagent_type/name");
	if (id === pkg.entryAgent) throw new Error("主理人不能派生自己，请指定团队成员 ID");
	return readPackageRole(definitionDir, pkg, id);
}

export function runtimeAdapter(member = false, team = true, definitionDir?: string): string {
	return (
		"\n\n## Kalo 运行适配（替代来源文档中的宿主工具和目录约定）\n" +
		"- 角色文件定义职责，不代表文档提及的工具已安装或操作已获用户授权。\n" +
		"- 长期资料与用户档案存于当前工作目录 profile/，交付产物存于 outputs/；不要使用来源正文中的桌面路径。\n" +
		(definitionDir
			? `- 专家定义目录为 ${definitionDir}，这不是任务工作目录。角色和技能从该目录的 agents/ 与 .kalo/skills/ 读取；不要向其中写任务产出。脚本和模板按技能文件的实际绝对路径解析。\n`
			: "- 技能使用 .kalo/skills/ 下的完整副本；脚本与模板按技能文件实际路径解析。\n") +
		"- 未配置图片服务或微信凭证时完成可执行的本地部分，明确列出缺失项，不编造图片、上传回执或阅读数据。\n" +
		(!team
			? ""
			: member
				? "- 你是被主理人派发的独立成员，只执行自己的任务。SendMessage 回传映射为本轮最终回复（自动返回主理人），不要调用不存在的 SendMessage/TeamCreate/Agent。\n"
				: "- 团队名单已加载，等价于来源流程的 TeamCreate；先向用户说明分工，再调用真实的 agent 工具，不要调用不存在的 TeamCreate/SendMessage/Agent。\n" +
					"- 派发格式：agent(subagent_type=成员ID, prompt=完整任务与路径, tools=[所需工具])；写文件需显式带 write/edit，运行脚本需 bash；省略 tools 仍只有默认只读工具。\n" +
					"- 成员最终回复自动回传主理人，长结果从转录或产物文件读取。成员之间的交接由你转述；用返回的 childId 作为 resume 续写，不能用成员 ID 代替 childId。\n")
	);
}

export function restoreMemberRole(entries: readonly SessionEntry[]): MemberRole | undefined {
	const entry = entries.find((entry) => entry.type === "custom" && entry.customType === MEMBER_ROLE_ENTRY);
	if (entry?.type !== "custom") return undefined;
	const role = entry.data as MemberRole;
	if (!role || typeof role.id !== "string" || typeof role.name !== "string" || typeof role.body !== "string") {
		throw new Error("子 agent 的持久化角色无效，不能降级为普通身份运行");
	}
	return role;
}

/** Read the role snapshot from this session, including after process restart/compaction. */
export function memberContextExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const role = restoreMemberRole(ctx.sessionManager.getEntries());
		if (!role) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## 专家团成员：${role.name} (${role.id})\n\n${role.body}${runtimeAdapter(true, true, role.definitionDir)}`,
		};
	});
}
