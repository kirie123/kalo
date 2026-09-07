import { describe, expect, it } from "vitest";
import { dangerousCommandReason } from "../src/extensions/permission/danger.ts";
import { isInside, isProtectedWrite, toAbsolute } from "../src/extensions/permission/paths.ts";
import { decide } from "../src/extensions/permission/policy.ts";
import type { GrantScope, PermissionMode } from "../src/extensions/permission/types.ts";

const WORKSPACE = process.platform === "win32" ? "D:\\project\\app" : "/project/app";
const AGENT_DIR = process.platform === "win32" ? "C:\\Users\\me\\.kalo\\agent" : "/home/me/.kalo/agent";

function inWorkspace(...parts: string[]): string {
	return [WORKSPACE, ...parts].join(process.platform === "win32" ? "\\" : "/");
}

function run(mode: PermissionMode, tool: string, input: Record<string, unknown>, grants: readonly GrantScope[] = []) {
	return decide({ mode, tool, input, workspace: WORKSPACE, agentDir: AGENT_DIR, grants });
}

describe("permission paths", () => {
	it("treats the workspace root itself as inside", () => {
		expect(isInside(WORKSPACE, WORKSPACE)).toBe(true);
	});

	it("compares segments, not string prefixes", () => {
		const sibling = process.platform === "win32" ? "D:\\project\\app-old\\a.ts" : "/project/app-old/a.ts";
		expect(isInside(sibling, WORKSPACE)).toBe(false);
	});

	it("resolves .. before comparing", () => {
		expect(isInside(inWorkspace("src", "..", "..", "other", "x.ts"), WORKSPACE)).toBe(false);
		expect(isInside(inWorkspace("src", "..", "a.ts"), WORKSPACE)).toBe(true);
	});

	it("ignores case differences in drive letters and segments", () => {
		if (process.platform !== "win32") return;
		expect(isInside("d:\\PROJECT\\App\\src\\a.ts", WORKSPACE)).toBe(true);
	});

	it("accepts forward slashes on Windows paths", () => {
		if (process.platform !== "win32") return;
		expect(isInside("D:/project/app/src/a.ts", WORKSPACE)).toBe(true);
	});

	it("keeps UNC server and share names significant", () => {
		if (process.platform !== "win32") return;
		expect(isInside("\\\\srv\\share\\a.ts", "\\\\srv\\share")).toBe(true);
		expect(isInside("\\\\srv\\other\\a.ts", "\\\\srv\\share")).toBe(false);
		expect(isInside("\\\\evil\\share\\a.ts", "\\\\srv\\share")).toBe(false);
	});

	it("resolves relative tool paths against the workspace", () => {
		expect(isInside(toAbsolute("src/a.ts", WORKSPACE), WORKSPACE)).toBe(true);
		expect(isInside(toAbsolute("../outside.ts", WORKSPACE), WORKSPACE)).toBe(false);
	});

	it("protects credentials and engine configuration", () => {
		for (const name of ["auth.json", "settings.json", "trust.json"]) {
			const target = [AGENT_DIR, name].join(process.platform === "win32" ? "\\" : "/");
			expect(isProtectedWrite(target, AGENT_DIR)).toBe(true);
		}
	});

	it("does not protect other files in the agent dir", () => {
		const target = [AGENT_DIR, "sessions", "a.jsonl"].join(process.platform === "win32" ? "\\" : "/");
		expect(isProtectedWrite(target, AGENT_DIR)).toBe(false);
	});
});

describe("dangerous command red line", () => {
	const refused: [string, string][] = [
		["rm -rf /", "posix root delete"],
		["rm -rf ~", "home delete"],
		["rm --recursive --force /", "long-flag root delete"],
		["rm -fr /*", "root glob delete"],
		["rd /s /q C:\\", "cmd root delete"],
		["Remove-Item -Recurse -Force C:\\", "powershell root delete"],
		["mkfs.ext4 /dev/sda1", "filesystem creation"],
		["format D:", "volume format"],
		["diskpart", "partition tool"],
		["bcdedit /set nointegritychecks on", "boot config"],
		["cipher /w C:\\", "free space wipe"],
		["reg delete HKLM\\SOFTWARE\\Microsoft /f", "machine registry delete"],
		["takeown /f C:\\ /r", "drive ownership"],
		["icacls C:\\ /grant Everyone:F /t", "drive acl"],
		["chmod -R 777 /", "recursive root chmod"],
		["dd if=/dev/zero of=/dev/sda", "raw disk write"],
		[":(){ :|:& };:", "fork bomb"],
		["echo hi && rm -rf /", "danger in a later segment"],
	];

	for (const [command, label] of refused) {
		it(`refuses ${label}: ${command}`, () => {
			expect(dangerousCommandReason(command)).toBeTypeOf("string");
		});
	}

	const allowed: [string, string][] = [
		["rm -rf ./build", "scoped recursive delete"],
		["rm -rf node_modules", "dependency cleanup"],
		["rm -rf /project/app/dist", "absolute but scoped"],
		["rm file.txt", "single file"],
		["npm run format", "npm script named format"],
		["./scripts/format-code.sh", "script whose name starts with format"],
		["prettier --write .", "formatter"],
		["reg query HKLM\\SOFTWARE", "registry read"],
		["reg delete HKCU\\Software\\MyApp /f", "per-user registry delete"],
		["chmod -R 755 ./scripts", "scoped recursive chmod"],
		["chmod 644 a.txt", "single file chmod"],
		["dd if=a.img of=b.img", "file to file dd"],
		["git clean -fd", "git clean"],
		["cargo check", "ordinary build"],
		["icacls ./dist /grant Everyone:F", "scoped acl"],
		["takeown /f ./dist", "scoped ownership"],
		["docker rm -f my-container", "docker remove"],
	];

	for (const [command, label] of allowed) {
		it(`allows ${label}: ${command}`, () => {
			expect(dangerousCommandReason(command)).toBeUndefined();
		});
	}
});

describe("read-only mode", () => {
	it("allows observation tools", () => {
		for (const tool of ["read", "grep", "glob", "ls", "find"]) {
			expect(run("read-only", tool, { path: inWorkspace("a.ts") }).kind).toBe("allow");
		}
	});

	it("asks before writing inside the workspace", () => {
		const decision = run("read-only", "write", { path: inWorkspace("a.ts"), content: "x" });
		expect(decision).toMatchObject({ kind: "ask", reason: "write-in-readonly" });
	});

	it("asks before writing outside the workspace", () => {
		const outside = process.platform === "win32" ? "D:\\other\\a.ts" : "/other/a.ts";
		expect(run("read-only", "edit", { path: outside }).kind).toBe("ask");
	});

	it("never offers a session grant, so the mode cannot silently decay", () => {
		const decision = run("read-only", "write", { path: inWorkspace("a.ts") });
		expect(decision).toMatchObject({ kind: "ask", grantable: undefined });
	});

	it("asks before every shell command", () => {
		const decision = run("read-only", "bash", { command: "npm test" });
		expect(decision).toMatchObject({ kind: "ask", reason: "bash-in-readonly", subject: "npm test" });
	});

	it("still refuses red-line commands outright", () => {
		expect(run("read-only", "bash", { command: "rm -rf /" }).kind).toBe("deny");
	});
});

describe("workspace-write mode", () => {
	it("allows writes inside the workspace", () => {
		expect(run("workspace-write", "write", { path: inWorkspace("src", "a.ts") }).kind).toBe("allow");
		expect(run("workspace-write", "edit", { path: "src/a.ts" }).kind).toBe("allow");
	});

	it("asks before writes outside the workspace", () => {
		const outside = process.platform === "win32" ? "D:\\other\\a.ts" : "/other/a.ts";
		const decision = run("workspace-write", "write", { path: outside });
		expect(decision).toMatchObject({ kind: "ask", reason: "write-outside-workspace" });
	});

	it("offers a per-directory grant when asking", () => {
		const outside = process.platform === "win32" ? "D:\\other\\deep\\a.ts" : "/other/deep/a.ts";
		const decision = run("workspace-write", "write", { path: outside });
		expect(decision).toMatchObject({ kind: "ask", grantable: { tool: "write" } });
	});

	it("honours a matching session grant", () => {
		const dir = process.platform === "win32" ? "D:\\other" : "/other";
		const target = process.platform === "win32" ? "D:\\other\\deep\\a.ts" : "/other/deep/a.ts";
		expect(run("workspace-write", "write", { path: target }, [{ tool: "write", dir }]).kind).toBe("allow");
	});

	it("does not apply a grant issued for a different tool", () => {
		const dir = process.platform === "win32" ? "D:\\other" : "/other";
		const target = process.platform === "win32" ? "D:\\other\\a.ts" : "/other/a.ts";
		expect(run("workspace-write", "edit", { path: target }, [{ tool: "write", dir }]).kind).toBe("ask");
	});

	it("does not apply a grant issued for a different directory", () => {
		const dir = process.platform === "win32" ? "D:\\granted" : "/granted";
		const target = process.platform === "win32" ? "D:\\other\\a.ts" : "/other/a.ts";
		expect(run("workspace-write", "write", { path: target }, [{ tool: "write", dir }]).kind).toBe("ask");
	});

	it("allows shell commands without approval", () => {
		expect(run("workspace-write", "bash", { command: "npm test" }).kind).toBe("allow");
	});

	it("treats ~/.kalo data directories as outside the workspace", () => {
		const target = [AGENT_DIR, "..", "memory", "note.md"].join(process.platform === "win32" ? "\\" : "/");
		expect(run("workspace-write", "write", { path: target }).kind).toBe("ask");
	});
});

describe("full-auto mode", () => {
	it("allows writes anywhere", () => {
		const outside = process.platform === "win32" ? "D:\\other\\a.ts" : "/other/a.ts";
		expect(run("full-auto", "write", { path: outside }).kind).toBe("allow");
		expect(run("full-auto", "edit", { path: inWorkspace("a.ts") }).kind).toBe("allow");
	});

	it("allows shell commands", () => {
		expect(run("full-auto", "bash", { command: "git push --force" }).kind).toBe("allow");
	});

	it("still refuses the red line, with no approval path", () => {
		const decision = run("full-auto", "bash", { command: "rm -rf /" });
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") expect(decision.reason).toContain("cannot be approved");
	});
});

describe("protected paths in every mode", () => {
	for (const mode of ["read-only", "workspace-write", "full-auto"] as PermissionMode[]) {
		it(`refuses writing auth.json in ${mode}`, () => {
			const target = [AGENT_DIR, "auth.json"].join(process.platform === "win32" ? "\\" : "/");
			expect(run(mode, "write", { path: target }).kind).toBe("deny");
		});

		it(`refuses editing settings.json in ${mode}`, () => {
			const target = [AGENT_DIR, "settings.json"].join(process.platform === "win32" ? "\\" : "/");
			expect(run(mode, "edit", { path: target }).kind).toBe("deny");
		});
	}
});

describe("tools outside the table", () => {
	it("allows request_user in every mode", () => {
		for (const mode of ["read-only", "workspace-write", "full-auto"] as PermissionMode[]) {
			expect(run(mode, "request_user", { question: "which one?" }).kind).toBe("allow");
		}
	});

	it("allows unknown tools rather than breaking MCP integrations", () => {
		expect(run("read-only", "some_mcp_tool", { anything: 1 }).kind).toBe("allow");
	});

	it("allows write calls with no usable path argument", () => {
		expect(run("read-only", "write", {}).kind).toBe("allow");
	});
});
