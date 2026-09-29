/**
 * present-files extension — lets the model declare its final deliverables.
 *
 * The desktop client never scans what the model wrote; it only knows what a
 * turn explicitly hands over. Without this tool "the work is done but nothing
 * shows up": the changed-files card is a heuristic over write/edit calls with
 * no notion of which files are the actual result, in what order, or which to
 * open first. `present_files` is that missing delivery contract — the model
 * lists the deliverables (local paths and/or http links), order is priority,
 * files[0] is opened automatically by the client.
 *
 * Like ask-user, the tool is ABSENT where there is no client to present to:
 * subagents (noExtensions) never load it, and unattended runs
 * (KALO_UNATTENDED=1) do not register it. Registration is decided at load time
 * because the tool list feeds the system-prompt prefix.
 *
 * Mechanism: the classified list rides `AgentToolResult.details` (the todo_write
 * pattern), so it lands in the session jsonl and replays unchanged. The client
 * renders the card from details on both live and replayed events; the
 * auto-open side effect fires only for live events (see chat-store).
 *
 * Design: doc/2026-09-28-产物呈现通道.md
 */

import { statSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type ClassifiedArtifact, classify } from "./classify.ts";

/** Env flag set by the desktop app for engines nobody is watching. */
const UNATTENDED_ENV = "KALO_UNATTENDED";

/** One presented deliverable, as it lands in the session jsonl and reaches the client. */
export interface ArtifactItem extends ClassifiedArtifact {
	/** File size in bytes (files only, when stat succeeded). */
	bytes?: number;
	/** True when a local file path does not exist. */
	missing?: true;
}

export interface PresentFilesDetails {
	artifacts: ArtifactItem[];
	/** Optional one-line description of the batch, shown under the artifacts heading. */
	explanation?: string;
}

const PresentFilesParams = Type.Object({
	files: Type.Array(Type.String({ description: "本地文件路径或 http/https 链接。" }), {
		description:
			"最终交付物列表，顺序即展示优先级，第一个会被自动打开。至少一个；只放真正给用户看的成果，不是每个中间文件。",
		minItems: 1,
	}),
	explanation: Type.Optional(Type.String({ description: "一句话说明这批产物是什么，展示在产物栏标题下。" })),
});

/** Add stat-derived size/existence to a classified file entry. Urls pass through. */
function withStat(item: ClassifiedArtifact): ArtifactItem {
	if (item.kind === "url") return { ...item };
	try {
		const st = statSync(item.path);
		if (st.isDirectory()) return { ...item, missing: true };
		return { ...item, bytes: st.size };
	} catch {
		return { ...item, missing: true };
	}
}

export default function presentFilesExtension(pi: ExtensionAPI): void {
	if (process.env[UNATTENDED_ENV] === "1") return;

	pi.registerTool({
		name: "present_files",
		label: "呈现产物",
		description:
			"Present your final deliverables to the user. Call this on the LAST turn whenever you produced " +
			"anything viewable — a report, web page, chart, document, or data file — so the client can show it. " +
			"The client does NOT discover files on its own; it only shows what this call lists. Pass paths " +
			"(local files) and/or http/https links in `files`; ORDER IS PRIORITY and files[0] is opened " +
			"automatically. List only the actual results, not every intermediate file, and drop anything a " +
			"later step superseded. The result reports which files were presented and which paths were missing.",
		promptSnippet: "present_files(files) — 产出可查看的最终成果时，收尾必调，声明交付物；files[0] 自动打开",
		promptGuidelines: [
			"凡产出了可查看的最终结果（报告/网页/图表/数据文件），收尾那一轮必须调用 present_files，否则用户看不到成果",
			"present_files 只放最终交付物，最重要的放 files[0]（会自动打开）；中间文件和被覆盖的旧产物不要列",
		],
		parameters: PresentFilesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const classified = classify(params.files as string[], ctx.cwd);
			if (classified.length === 0) throw new Error("present_files：files 里没有有效条目");
			const artifacts = classified.map(withStat);

			const presented = artifacts.filter((a) => a.missing !== true).map((a) => a.name);
			const missing = artifacts.filter((a) => a.missing === true).map((a) => a.path);
			const primary = artifacts.find((a) => a.primary)?.name;

			const details: PresentFilesDetails = {
				artifacts,
				...(params.explanation !== undefined ? { explanation: params.explanation } : {}),
			};
			return {
				content: [{ type: "text", text: JSON.stringify({ presented, missing, primary }) }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const count = (args.files as string[]).length;
			return new Text(theme.fg("toolTitle", theme.bold("present ")) + theme.fg("muted", `${count} 个产物`), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as PresentFilesDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			let text = "";
			for (const [index, item] of details.artifacts.entries()) {
				if (index > 0) text += "\n";
				const mark = item.primary ? theme.fg("accent", "★ ") : theme.fg("dim", "· ");
				const name = item.missing ? theme.fg("error", `${item.name}（缺失）`) : theme.fg("muted", item.name);
				text += `${mark}${name}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
