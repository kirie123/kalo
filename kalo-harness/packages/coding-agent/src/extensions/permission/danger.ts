/**
 * The red line: operations refused in EVERY permission mode, with no approval
 * option offered.
 *
 * Rationale for "no approval": clicking Allow in a dialog does not let anyone
 * meaningfully evaluate `rm -rf /`. Making it approvable only adds a formality
 * to a disaster. A user who genuinely wants such a command should run it in
 * their own terminal — that is an explicit human act, not an agent act.
 *
 * This is a SPEED BUMP, not a security boundary. Shell text has unbounded
 * variety (quoting, variable expansion, aliases, base64, `&&` chains), so a
 * determined bypass always exists. The list therefore stays deliberately SHORT:
 * every extra pattern buys false positives, and a matcher that cries wolf is
 * one nobody trusts. Only irreversible operations with essentially no
 * legitimate agent use belong here.
 *
 * Windows is the default contract: `bash` runs through a shell that may be
 * bash, cmd, or PowerShell (users can override `shellPath`), so POSIX and
 * Windows spellings are both matched.
 */

/** Split a command line into segments that each start a new command. */
function segmentsOf(command: string): string[] {
	return command
		.split(/\r?\n|&&|\|\||[;|&]/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

/** Tokenize one segment, dropping surrounding quotes. Good enough for head-token checks. */
function tokensOf(segment: string): string[] {
	const matches = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return matches.map((token) => token.replace(/^["']|["']$/g, ""));
}

/** The executable name without path or extension, lowercased. */
function commandName(token: string): string {
	const base = token.replaceAll("\\", "/").split("/").pop() ?? token;
	return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
}

/**
 * Whether a path argument denotes a filesystem root or the user's home as a
 * whole. `/*` and `C:\*` count: the glob expands to everything under the root.
 */
function isRootTarget(argument: string): boolean {
	const value = argument
		.trim()
		.replaceAll("\\", "/")
		.replace(/\/\*?$/, "/");
	return (
		value === "/" ||
		value === "~" ||
		value === "~/" ||
		value === "$HOME" ||
		value === "%USERPROFILE%" ||
		/^[a-z]:\/$/i.test(value)
	);
}

/** Flags of a POSIX `rm` that make it both recursive and forced. */
function isRecursiveForcedRm(tokens: string[]): boolean {
	let recursive = false;
	let forced = false;
	for (const token of tokens.slice(1)) {
		if (token === "--recursive") recursive = true;
		else if (token === "--force") forced = true;
		else if (/^-[a-z]+$/i.test(token)) {
			if (token.includes("r") || token.includes("R")) recursive = true;
			if (token.includes("f")) forced = true;
		}
	}
	return recursive && forced;
}

/**
 * Non-flag arguments. Only `-`-prefixed tokens are dropped: a leading `/` must
 * survive, because on POSIX it is the root path we are looking for. Windows
 * switches like `/s` are handled through {@link switchesOf} instead, and they
 * are not root targets anyway.
 */
function pathArguments(tokens: string[]): string[] {
	return tokens.slice(1).filter((token) => !token.startsWith("-"));
}

/** All arguments including Windows-style `/s` switches, for switch inspection. */
function switchesOf(tokens: string[]): string[] {
	return tokens.slice(1).map((token) => token.toLowerCase());
}

const DANGEROUS_COMMANDS = new Set(["diskpart", "bcdedit", "fdisk", "shutdown", "mkfs"]);

/**
 * Why this segment is refused, or undefined when it passes.
 * Returning the reason (not just a boolean) lets the model be told precisely
 * what tripped, so it can explain itself instead of blindly retrying.
 */
function refuseSegment(segment: string): string | undefined {
	const tokens = tokensOf(segment);
	if (tokens.length === 0) return undefined;
	const name = commandName(tokens[0] as string);
	const switches = switchesOf(tokens);

	if (name === "rm" && isRecursiveForcedRm(tokens) && pathArguments(tokens).some(isRootTarget)) {
		return "recursive forced delete of a filesystem root or home directory";
	}

	// cmd: rd /s /q C:\   (rmdir is the same builtin)
	if (
		(name === "rd" || name === "rmdir") &&
		switches.includes("/s") &&
		tokens.slice(1).some((token) => isRootTarget(token))
	) {
		return "recursive delete of a filesystem root";
	}

	// PowerShell: Remove-Item -Recurse -Force C:\
	if (name === "remove-item" && switches.some((s) => s.startsWith("-recurse"))) {
		if (tokens.slice(1).some((token) => isRootTarget(token))) {
			return "recursive delete of a filesystem root";
		}
	}

	// Filesystem creation wipes the target volume.
	if (name.startsWith("mkfs") || name === "newfs") {
		return "creating a filesystem (destroys the target volume)";
	}

	// `format` only when it targets a volume, so `format-code.sh` and a
	// `format` npm script are unaffected (their command name differs anyway).
	if (name === "format" && tokens.slice(1).some((token) => /^[a-z]:$/i.test(token.trim()))) {
		return "formatting a volume";
	}

	if (DANGEROUS_COMMANDS.has(name) && name !== "mkfs") {
		return `${name} (disk, boot, or system-level operation)`;
	}

	// Wiping free space is irreversible and never needed by an agent.
	if (name === "cipher" && switches.includes("/w")) {
		return "cipher /w (irreversible free-space wipe)";
	}

	// Deleting a machine-wide registry hive breaks the OS.
	if (name === "reg" && switches[0] === "delete") {
		const target = (switches[1] ?? "").replaceAll("/", "\\");
		if (/^hk(lm|ey_local_machine)(\\|$)/.test(target) || /^hk(cr|ey_classes_root)(\\|$)/.test(target)) {
			return "deleting a machine-wide registry key";
		}
	}

	// Taking ownership of or re-ACLing an entire drive.
	if ((name === "takeown" || name === "icacls") && switches.some((s) => s === "/r" || s === "/t")) {
		if (tokens.slice(1).some((token) => isRootTarget(token))) {
			return `${name} over an entire drive`;
		}
	}

	if (name === "chmod" || name === "chown") {
		const recursive = switches.some((s) => s === "-r" || s === "--recursive");
		if (recursive && pathArguments(tokens).some(isRootTarget)) {
			return `recursive ${name} over a filesystem root`;
		}
	}

	if (name === "dd" && switches.some((s) => /^of=\/dev\/(sd|nvme|disk|hd)/i.test(s))) {
		return "dd writing directly to a block device";
	}

	return undefined;
}

/** Classic fork bomb and its common spacing variants. */
const FORK_BOMB = /(\w*)\s*\(\s*\)\s*\{[^}]*\|\s*\1[^}]*&[^}]*\}\s*;?\s*\1/;

/**
 * The refusal reason for a whole command line, or undefined when it may proceed
 * to normal mode-based judgement.
 */
export function dangerousCommandReason(command: string): string | undefined {
	if (FORK_BOMB.test(command)) return "fork bomb";
	for (const segment of segmentsOf(command)) {
		const reason = refuseSegment(segment);
		if (reason !== undefined) return reason;
	}
	return undefined;
}
