/**
 * Memory extension — Kalo's personal long-term memory.
 *
 * - Registers memory_save / memory_search / memory_list tools so the model
 *   can actively persist and retrieve knowledge.
 * - Injects a memory index (title + tags + summary) into the system prompt
 *   before every agent run.
 * - /remember <content> stores a memory manually.
 *
 * Storage: ~/.kalo/memory/<slug>.md (frontmatter + body), plain files, no
 * database. The Kalo desktop settings page manages the same directory, so
 * the frontmatter format must stay in sync with
 * kalo-desktop/src-tauri/src/memory.rs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

interface Memory {
	slug: string;
	title: string;
	tags: string[];
	created: string;
	updated: string;
	body: string;
}

/** System-prompt index caps: entry count and total characters (overflow is dropped newest-first). */
const MAX_INDEX_ENTRIES = 50;
const MAX_INDEX_CHARS = 2000;
/** Max body characters returned per search result. */
const MAX_RESULT_BODY_CHARS = 1500;

function memoryDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "memory");
}

/** Summary = first non-empty body line (Markdown heading marks stripped), truncated to 80 chars. */
function summaryOf(body: string): string {
	const line =
		body
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	return line.replace(/^#+\s*/, "").slice(0, 80);
}

function slugify(title: string): string {
	const slug = title
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || `m-${Date.now().toString(36)}`;
}

/** Frontmatter string values are always quoted so colons/special chars cannot break parsing. */
function quote(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
		return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return t;
}

function serialize(m: Memory): string {
	const tags = m.tags.map(quote).join(", ");
	return `---\ntitle: ${quote(m.title)}\ntags: [${tags}]\ncreated: ${m.created}\nupdated: ${m.updated}\n---\n\n${m.body.trim()}\n`;
}

function parse(slug: string, text: string): Memory | null {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	let title = "";
	let created = "";
	let updated = "";
	let tags: string[] = [];
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "---") {
			i++;
			break;
		}
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key === "title") title = unquote(value);
		else if (key === "created") created = value;
		else if (key === "updated") updated = value;
		else if (key === "tags" && value.startsWith("[") && value.endsWith("]")) {
			tags = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
		}
	}
	const body = lines.slice(i).join("\n").trim();
	if (!title) return null;
	return { slug, title, tags, created, updated, body };
}

/** Load all memories, newest first; a missing directory or a corrupt file is not an error. */
function loadAll(): Memory[] {
	let names: string[];
	try {
		names = readdirSync(memoryDir());
	} catch {
		return [];
	}
	const out: Memory[] = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		try {
			const m = parse(name.replace(/\.md$/, ""), readFileSync(join(memoryDir(), name), "utf8"));
			if (m) out.push(m);
		} catch {
			// skip corrupt memory files
		}
	}
	out.sort((a, b) => b.updated.localeCompare(a.updated));
	return out;
}

function save(input: { title: string; content: string; tags?: string[]; slug?: string }): Memory {
	const dir = memoryDir();
	mkdirSync(dir, { recursive: true });
	const slug = input.slug?.trim() || slugify(input.title);
	const file = join(dir, `${slug}.md`);
	const now = new Date().toISOString();
	// Preserve the original created timestamp when overwriting.
	let created = now;
	if (existsSync(file)) {
		try {
			const prev = parse(slug, readFileSync(file, "utf8"));
			if (prev?.created) created = prev.created;
		} catch {
			// corrupt old file, overwrite from scratch
		}
	}
	const m: Memory = {
		slug,
		title: input.title.trim(),
		tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
		created,
		updated: now,
		body: input.content.trim(),
	};
	writeFileSync(file, serialize(m), "utf8");
	return m;
}

/** Keyword search: title x5 / tags x4 / summary x2 / body x1, highest score first. */
function search(query: string, limit: number): Memory[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	const scored: Array<{ m: Memory; score: number }> = [];
	for (const m of loadAll()) {
		const title = m.title.toLowerCase();
		const tags = m.tags.join(" ").toLowerCase();
		const summary = summaryOf(m.body).toLowerCase();
		const body = m.body.toLowerCase();
		let score = 0;
		for (const t of terms) {
			if (title.includes(t)) score += 5;
			if (tags.includes(t)) score += 4;
			if (summary.includes(t)) score += 2;
			if (body.includes(t)) score += 1;
		}
		if (score > 0) scored.push({ m, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.m);
}

function indexLine(m: Memory): string {
	const tagStr = m.tags.length ? `[${m.tags.join("/")}] ` : "";
	const summary = summaryOf(m.body);
	return `- ${tagStr}${m.title}${summary && summary !== m.title ? ` — ${summary}` : ""}`;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function memoryExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Save a piece of long-term memory about the user (preferences, habits, facts, decisions, lessons learned). " +
			"Pass an existing slug to update that memory. The first line of content doubles as the summary shown in the memory index.",
		promptSnippet: "memory_save(title, content, tags?, slug?) — 沉淀/更新一条长期记忆",
		promptGuidelines: [
			"用户分享偏好、习惯、重要事实、项目决定，或明确说“记住”时，调用 memory_save 沉淀为长期记忆",
			"memory_save 的 content 第一行会作为索引摘要，先写一句概括再展开细节",
			"更新已有记忆时传入它的 slug（见系统提示中的记忆索引或 memory_list 结果）",
		],
		parameters: Type.Object({
			title: Type.String({ description: "简短标题" }),
			content: Type.String({ description: "记忆正文；第一行作为索引摘要" }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "分类标签，如 preference / project / reading" })),
			slug: Type.Optional(Type.String({ description: "更新已有记忆时传入其 slug；留空则按标题生成" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const m = save(params);
				const tagStr = m.tags.length ? `，标签：${m.tags.join(", ")}` : "";
				return {
					content: [{ type: "text", text: `已记住「${m.title}」（${m.slug}.md${tagStr}）` }],
					details: { slug: m.slug, title: m.title, tags: m.tags },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `memory_save 失败：${errText(err)}` }],
					details: { error: errText(err) },
				};
			}
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search the user's long-term memory by keywords. Returns matching memories with their full content " +
			"(truncated). Use this when a question may involve the user's preferences, history, or past decisions.",
		promptSnippet: "memory_search(query, limit?) — 按关键词检索长期记忆全文",
		promptGuidelines: ["回答可能涉及用户偏好、经历或过往决定前，先用 memory_search 检索记忆"],
		parameters: Type.Object({
			query: Type.String({ description: "检索关键词（空格分隔多个词）" }),
			limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 5" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const results = search(params.query, params.limit ?? 5);
				if (results.length === 0) {
					return { content: [{ type: "text", text: "没有匹配的记忆。" }], details: { count: 0 } };
				}
				const text = results
					.map((m) => {
						const body =
							m.body.length > MAX_RESULT_BODY_CHARS
								? `${m.body.slice(0, MAX_RESULT_BODY_CHARS)}…（已截断）`
								: m.body;
						const tagStr = m.tags.length ? `，tags: ${m.tags.join(", ")}` : "";
						return `## ${m.title}（slug: ${m.slug}${tagStr}，updated: ${m.updated}）\n${body}`;
					})
					.join("\n\n");
				return { content: [{ type: "text", text }], details: { count: results.length } };
			} catch (err) {
				return {
					content: [{ type: "text", text: `memory_search 失败：${errText(err)}` }],
					details: { error: errText(err) },
				};
			}
		},
	});

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List the index (slug, title, tags, summary) of all long-term memories, newest first.",
		parameters: Type.Object({
			tag: Type.Optional(Type.String({ description: "只列出带该标签的记忆" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				let memories = loadAll();
				if (params.tag) {
					const tag = params.tag.toLowerCase();
					memories = memories.filter((m) => m.tags.some((t) => t.toLowerCase() === tag));
				}
				if (memories.length === 0) {
					return { content: [{ type: "text", text: "还没有任何记忆。" }], details: { count: 0 } };
				}
				const text = memories.map((m) => `${indexLine(m)}（slug: ${m.slug}）`).join("\n");
				return { content: [{ type: "text", text }], details: { count: memories.length } };
			} catch (err) {
				return {
					content: [{ type: "text", text: `memory_list 失败：${errText(err)}` }],
					details: { error: errText(err) },
				};
			}
		},
	});

	// Inject the memory index into the system prompt before every agent run.
	pi.on("before_agent_start", async (event) => {
		const memories = loadAll();
		if (memories.length === 0) return;
		const lines: string[] = [];
		let total = 0;
		for (const m of memories.slice(0, MAX_INDEX_ENTRIES)) {
			const line = indexLine(m);
			if (total + line.length > MAX_INDEX_CHARS) break;
			lines.push(line);
			total += line.length;
		}
		if (lines.length === 0) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## 长期记忆\n\n以下是你为用户沉淀的个人知识索引（存于 ~/.kalo/memory/，可在设置页管理）。回答涉及用户偏好、习惯、过往决定时，先用 memory_search 检索全文；发现值得长期保留的新信息时，用 memory_save 更新。\n\n<user_memory>\n${lines.join("\n")}\n</user_memory>`,
		};
	});

	// Manual entry point: /remember <content>, first line (truncated) becomes the title.
	pi.registerCommand("remember", {
		description: "记一条长期记忆（用法：/remember <内容>）",
		handler: async (args, ctx) => {
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("用法：/remember <要记住的内容>", "warning");
				return;
			}
			const firstLine = content.split(/\r?\n/)[0].trim();
			const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
			try {
				const m = save({ title, content });
				ctx.ui.notify(`已记住：${m.title}`, "info");
			} catch (err) {
				ctx.ui.notify(`记忆失败：${errText(err)}`, "error");
			}
		},
	});
}
