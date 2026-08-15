/**
 * Kalo skills bundle — ships the built-in workflow skills
 * (paper-reading / web-research / experiment-runner / math).
 *
 * Skill contents are embedded as string constants and written to
 * ~/.kalo/skills/<name>/SKILL.md on session start when missing. Existing
 * files are never overwritten: user edits via the settings page survive
 * engine upgrades (the flip side: bundled content updates do not
 * propagate automatically).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import experimentRunner from "./experiment-runner.ts";
import math from "./math.ts";
import paperReading from "./paper-reading.ts";
import webResearch from "./web-research.ts";

const SKILLS: Array<{ name: string; content: string }> = [
	{ name: "paper-reading", content: paperReading },
	{ name: "web-research", content: webResearch },
	{ name: "experiment-runner", content: experimentRunner },
	{ name: "math", content: math },
];

export default function kaloSkillsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// User skills live in ~/.kalo/skills (sibling of the agent dir).
		const root = resolve(getAgentDir(), "..", "skills");
		const installed: string[] = [];
		for (const skill of SKILLS) {
			const file = join(root, skill.name, "SKILL.md");
			if (existsSync(file)) continue;
			try {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, skill.content, "utf8");
				installed.push(skill.name);
			} catch {
				// Unwritable skills root — skip this skill, others may still install.
			}
		}
		if (installed.length > 0) {
			try {
				ctx.ui.notify(`已安装内置技能：${installed.join("、")}`, "info");
			} catch {
				// Stale context — installation already happened, notification is optional.
			}
		}
	});
}
