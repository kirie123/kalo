import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "../../core/session-manager.ts";

export const DEFAULT_TOOLS = ["read", "grep", "glob", "ls", "web_fetch"];
const ALLOWED_TOOLS = new Set(["read", "grep", "glob", "find", "ls", "bash", "edit", "write", "web_fetch"]);
export const CHILD_TOOLS_ENTRY = "kalo-subagent-tools";

/** Only omission selects defaults. An explicit empty list means no tools. */
export function normalizeTools(value: unknown = DEFAULT_TOOLS): string[] {
	const items: unknown[] =
		typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : Array.isArray(value) ? value : [];
	if (typeof value !== "string" && !Array.isArray(value)) throw new Error("tools 必须是名称数组或逗号/空白分隔字符串");
	const names = items.map((item) => {
		if (typeof item !== "string" || !ALLOWED_TOOLS.has(item.trim()))
			throw new Error(`未知子 agent 工具：${String(item)}`);
		return item.trim();
	});
	return [...new Set(names)];
}

export function validateChildId(childId: string): void {
	if (!/^subagent-(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(childId)) {
		throw new Error(`未知子 agent：${childId}`);
	}
}

/** Separate metadata is durable even before SessionManager flushes its first assistant message. */
export function persistChildTools(directory: string, childId: string, tools: string[]): void {
	validateChildId(childId);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${childId}.tools.json`);
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify({ version: 1, childId, tools: normalizeTools(tools) }), { mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* Preserve the original failure. */
		}
		throw error;
	}
}

/** Never infer permissions from tool calls or a resume request. Legacy sessions without evidence get []. */
export function restoreChildTools(directory: string, childId: string, entries: readonly SessionEntry[] = []): string[] {
	validateChildId(childId);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(directory, `${childId}.tools.json`), "utf8"));
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (value !== undefined) {
		if (
			!value ||
			typeof value !== "object" ||
			!("version" in value) ||
			value.version !== 1 ||
			!("childId" in value) ||
			value.childId !== childId ||
			!("tools" in value) ||
			!Array.isArray(value.tools)
		) {
			throw new Error(`子 agent 工具元数据无效：${childId}`);
		}
		return normalizeTools(value.tools);
	}
	const entry = entries.find((entry) => entry.type === "custom" && entry.customType === CHILD_TOOLS_ENTRY);
	if (entry?.type === "custom") {
		const data: unknown = entry.data;
		if (!data || typeof data !== "object" || !("tools" in data) || !Array.isArray(data.tools)) {
			throw new Error(`子 agent 工具记录无效：${childId}`);
		}
		return normalizeTools(data.tools);
	}
	return [];
}
