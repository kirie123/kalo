/**
 * Skill extension — dedicated skill tool + in-session skill refresh.
 *
 * - Registers a `use_skill` tool so the model loads skill instructions by
 *   name instead of resolving file paths through the read tool.
 * - Watches the user (~/.kalo/skills) and project (<cwd>/.kalo/skills)
 *   skill directories; on change it re-scans and the next agent turn's
 *   system prompt gets a fresh <available_skills> catalog.
 *
 * The engine bakes the catalog into the system prompt at session start.
 * This extension rewrites that block in before_agent_start from its own
 * freshly scanned skill set, so mid-session edits take effect on the next
 * turn without a session restart. Skill bodies are always read from disk
 * at call time, so use_skill never serves stale content either.
 */

import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { formatSkillsForPrompt, loadSkills, type Skill } from "../../core/skills.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";

/** Debounce window for coalescing filesystem watch events. */
const WATCH_DEBOUNCE_MS = 500;

/**
 * Matches the block formatSkillsForPrompt emits: the fixed guidance lines
 * through </available_skills>. Used to replace the stale catalog baked
 * into the system prompt at session start.
 */
const SKILLS_BLOCK_PATTERN = /\n\nThe following skills provide[\s\S]*?<\/available_skills>/;

export default function skillExtension(pi: ExtensionAPI): void {
	let cwd = process.cwd();
	let skills: Skill[] = [];
	let watchers: FSWatcher[] = [];
	let debounce: ReturnType<typeof setTimeout> | undefined;
	// Latest event context, kept so the watcher callback can notify.
	let lastCtx: ExtensionContext | undefined;

	function skillDirs(): string[] {
		return [resolve(getAgentDir(), "..", "skills"), join(cwd, CONFIG_DIR_NAME, "skills")];
	}

	function rescan(): void {
		skills = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills;
	}

	function closeWatchers(): void {
		for (const w of watchers) w.close();
		watchers = [];
		if (debounce !== undefined) {
			clearTimeout(debounce);
			debounce = undefined;
		}
	}

	/**
	 * Watch the skill roots. fs.watch recursive is unsupported on Linux, so
	 * fall back to watching each first-level subdirectory (skill bodies live
	 * in <root>/<name>/SKILL.md). Re-armed after every rescan so newly
	 * created skill directories get picked up.
	 */
	function armWatchers(): void {
		closeWatchers();
		for (const root of skillDirs()) {
			if (!existsSync(root)) continue;
			try {
				watchers.push(watch(root, { recursive: true }, onChange));
				continue;
			} catch {
				// recursive unsupported — fall through to per-directory watches
			}
			try {
				watchers.push(watch(root, onChange));
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					try {
						watchers.push(watch(join(root, entry.name), onChange));
					} catch {
						// unreadable subdirectory, skip
					}
				}
			} catch {
				// unreadable root, skip
			}
		}
	}

	function onChange(): void {
		if (debounce !== undefined) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = undefined;
			rescan();
			armWatchers();
			try {
				lastCtx?.ui.notify(`技能目录已变更，技能列表已刷新（${skills.length} 个）`, "info");
			} catch {
				// stale context after session replacement — the rescan still stands
			}
		}, WATCH_DEBOUNCE_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		lastCtx = ctx;
		rescan();
		armWatchers();
	});

	pi.on("session_shutdown", async () => {
		closeWatchers();
	});

	// Rewrite the skill catalog baked into the system prompt so mid-session
	// skill edits/additions show up on the next turn.
	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		const fresh = formatSkillsForPrompt(skills);
		const current = event.systemPrompt;
		if (SKILLS_BLOCK_PATTERN.test(current)) {
			return { systemPrompt: current.replace(SKILLS_BLOCK_PATTERN, fresh) };
		}
		if (fresh) {
			return { systemPrompt: current + fresh };
		}
	});

	pi.registerTool({
		name: "use_skill",
		label: "Use Skill",
		description:
			"Load a skill's full instructions by name. Available skills are listed in the <available_skills> " +
			"section of the system prompt; call this when the task matches a skill's description.",
		promptSnippet: "use_skill(name) — 按名字加载技能的完整指令",
		promptGuidelines: ["任务匹配某个技能的 description 时，先调用 use_skill 加载它的完整指令再执行"],
		parameters: Type.Object({
			name: Type.String({ description: "技能名（<available_skills> 里的 name）" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Skills carrying disableModelInvocation are excluded from the
			// catalog and must not be model-invocable here either.
			const visible = skills.filter((s) => !s.disableModelInvocation);
			const skill = visible.find((s) => s.name === params.name);
			if (!skill) {
				const available = visible.map((s) => s.name).join(", ") || "（无）";
				return {
					content: [{ type: "text", text: `未找到技能 "${params.name}"。可用技能：${available}` }],
					details: { error: "skill not found" },
				};
			}
			try {
				const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
				return {
					content: [
						{
							type: "text",
							text: `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
						},
					],
					details: { name: skill.name, location: skill.filePath },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `读取技能 "${params.name}" 失败：${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
