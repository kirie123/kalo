import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import expertContextExtension from "../src/extensions/expert-context/index.ts";
import {
	MEMBER_ROLE_ENTRY,
	memberContextExtension,
	readExpertPackage,
	readPackageRole,
	resolveMemberRole,
	restoreMemberRole,
} from "../src/extensions/expert-context/package.ts";

const dirs: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kalo-expert-"));
	dirs.push(root);
	mkdirSync(join(root, ".kalo"));
	mkdirSync(join(root, "agents"));
	writeFileSync(
		join(root, ".kalo", "expert.json"),
		JSON.stringify({
			kind: "team",
			entryAgent: "lead",
			members: [
				{ id: "lead", name: "主理人", profession: "编排", agentPath: "agents/lead.md" },
				{ id: "writer", name: "作者", profession: "撰稿", agentPath: "agents/writer.md" },
			],
		}),
	);
	writeFileSync(join(root, "agents", "lead.md"), "---\nname: lead\n---\n主理人正文");
	writeFileSync(
		join(root, "agents", "writer.md"),
		"---\r\nname: writer\r\ndisplayName:\r\n  zh: 作者\r\nmaxTurns: 10\r\n---\r\n只执行撰稿\r\n",
	);
	return root;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("expert package roles", () => {
	it("injects the selected source into a different task and persists the expert identity", async () => {
		const definition = fixture();
		const task = mkdtempSync(join(tmpdir(), "kalo-task-context-"));
		dirs.push(task);
		vi.stubEnv("KALO_EXPERT_ID", "editors");
		vi.stubEnv("KALO_EXPERT_DIR", definition);
		let handler: (...args: unknown[]) => Promise<{ systemPrompt: string } | undefined> = async () => undefined;
		const appendEntry = vi.fn();
		expertContextExtension({
			on: (_name: string, fn: typeof handler) => {
				handler = fn;
			},
			appendEntry,
		} as unknown as ExtensionAPI);
		const result = await handler({ systemPrompt: "base" }, { cwd: task, sessionManager: { getEntries: () => [] } });
		expect(result?.systemPrompt).toContain("主理人正文");
		expect(result?.systemPrompt).toContain(`当前任务工作目录为 ${task}`);
		expect(result?.systemPrompt).toContain(`专家定义目录为 ${definition}`);
		expect(appendEntry).toHaveBeenCalledWith("kalo-expert-context", { id: "editors" });
	});
	it("loads YAML frontmatter and keeps the body, including Windows newlines", () => {
		const role = resolveMemberRole(fixture(), "writer");
		expect(role).toMatchObject({ id: "writer", name: "作者", body: "只执行撰稿" });
		expect(role.definitionDir).toBeTruthy();
	});

	it("loads roles from a selected definition while keeping a different task cwd", () => {
		const definition = fixture();
		const task = mkdtempSync(join(tmpdir(), "kalo-task-"));
		dirs.push(task);
		const role = resolveMemberRole(task, "writer", definition);
		expect(role.body).toBe("只执行撰稿");
		expect(role.definitionDir).toBe(definition);
		expect(readExpertPackage(task)).toBeUndefined();
	});
	it("does not treat ordinary workspaces as teams or invent unknown roles", () => {
		const root = fixture();
		expect(() => resolveMemberRole(root, "lead")).toThrow("不能派生自己");
		expect(() => resolveMemberRole(root, "other")).toThrow("未知专家团成员");
		expect(readExpertPackage(join(root, "agents"))).toBeUndefined();
	});
	it("rejects traversal and foreign-platform absolute paths", () => {
		const root = fixture();
		const pkg = readExpertPackage(root)!;
		for (const path of ["../writer.md", "..\\writer.md", "C:\\writer.md", "\\\\server\\share\\writer.md"]) {
			pkg.members[1].agentPath = path;
			expect(() => readPackageRole(root, pkg, "writer")).toThrow("路径无效");
		}
	});
	it.runIf(process.platform !== "win32")("rejects a symlink outside the workspace", () => {
		const root = fixture();
		const other = fixture();
		rmSync(join(root, "agents", "writer.md"));
		symlinkSync(join(other, "agents", "writer.md"), join(root, "agents", "writer.md"));
		expect(() => resolveMemberRole(root, "writer")).toThrow("越出");
	});
	it("fails on mismatched frontmatter instead of silently assuming a role", () => {
		const root = fixture();
		writeFileSync(join(root, "agents", "writer.md"), "---\nname: other\n---\n正文");
		expect(() => resolveMemberRole(root, "writer")).toThrow("name 或正文无效");
	});
	it("restores a persisted role snapshot even when the source role changes", () => {
		const root = fixture();
		const role = resolveMemberRole(root, "writer");
		writeFileSync(join(root, "agents", "writer.md"), "changed");
		const entries = [{ type: "custom", customType: MEMBER_ROLE_ENTRY, data: role }] as SessionEntry[];
		expect(restoreMemberRole(entries)?.body).toBe("只执行撰稿");
		expect(restoreMemberRole([])).toBeUndefined();
	});
	it("registers per-session role injection and maps member return to the tool result", async () => {
		const role = resolveMemberRole(fixture(), "writer");
		let handler: (...args: unknown[]) => Promise<{ systemPrompt: string } | undefined> = async () => undefined;
		const pi = {
			on: (_name: string, fn: typeof handler) => {
				handler = fn;
			},
		} as unknown as ExtensionAPI;
		memberContextExtension(pi);
		const result = await handler(
			{ systemPrompt: "base" },
			{ sessionManager: { getEntries: () => [{ type: "custom", customType: MEMBER_ROLE_ENTRY, data: role }] } },
		);
		expect(result?.systemPrompt).toContain("只执行撰稿");
		expect(result?.systemPrompt).toContain("本轮最终回复");
	});
});
