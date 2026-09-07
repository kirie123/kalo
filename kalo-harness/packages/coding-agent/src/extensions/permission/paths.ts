/**
 * Workspace containment and protected-path checks.
 *
 * Pure and lexical: no fs access, so a symlink pointing out of the workspace
 * still reads as inside. That is acceptable here — permission mode guards
 * against model mistakes, not against a crafted symlink (see the security
 * section of doc/2026-09-07-权限模式.md). Keeping it pure is what makes the
 * whole decision table unit-testable.
 *
 * Windows is the default contract: comparison is case-insensitive, `\` and `/`
 * are equivalent, and containment compares path SEGMENTS, never string
 * prefixes — otherwise `D:\work` would swallow `D:\work-old`.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Split an absolute path into comparable segments. Case is folded because both
 * NTFS and macOS default to case-insensitive; folding on Linux may merge two
 * genuinely distinct paths, which errs toward asking the user rather than
 * silently writing.
 */
function segments(absolutePath: string): string[] {
	const normalized = resolve(absolutePath).replaceAll("/", sep);
	// A UNC root (\\server\share) keeps its leading empty segments, so server and
	// share names participate in the comparison instead of being dropped.
	return normalized
		.toLowerCase()
		.split(sep)
		.filter((segment, index) => segment !== "" || index < 2);
}

/** Resolve `candidate` against `base` when it is relative. */
export function toAbsolute(candidate: string, base: string): string {
	return isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
}

/**
 * Whether `candidate` is `root` itself or lives under it.
 *
 * `isInside("D:/work", "D:/work")` is true: writing the workspace directory
 * itself (e.g. creating a file in it) is an inside operation.
 */
export function isInside(candidate: string, root: string): boolean {
	const candidateSegments = segments(candidate);
	const rootSegments = segments(root);
	if (candidateSegments.length < rootSegments.length) return false;
	return rootSegments.every((segment, index) => candidateSegments[index] === segment);
}

/**
 * Paths whose writes are refused in every mode. The model has no legitimate
 * reason to rewrite its own credentials or the user's trust decisions, and a
 * mangled auth.json breaks the session outright.
 */
export function protectedWritePaths(agentDir: string): string[] {
	return ["auth.json", "settings.json", "trust.json"].map((name) => resolve(agentDir, name));
}

/** Default agent dir; mirrors `getAgentDir()` without importing the config module. */
export function defaultAgentDir(): string {
	return resolve(homedir(), ".kalo", "agent");
}

/** Whether writing `target` would touch a protected file. */
export function isProtectedWrite(target: string, agentDir: string): boolean {
	const absolute = resolve(target);
	return protectedWritePaths(agentDir).some((path) => segments(path).join(sep) === segments(absolute).join(sep));
}
