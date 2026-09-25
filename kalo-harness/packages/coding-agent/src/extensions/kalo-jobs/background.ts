/**
 * Background execution for the bash tool — the producer side of the job
 * runtime (doc/2026-09-24-bash-后台模式.md).
 *
 * The foreground bash path spawns a local shell; this module hands the same
 * command to the gateway's job runtime instead, so the work gets an id, a log
 * file, owner fencing, completion notices, and a row in the desktop job panel
 * for free. Everything here is composition + error translation: transport is
 * {@link JobsClient}, policy is the gateway.
 *
 * The gateway is required. There is deliberately no local fallback: a detached
 * process the session cannot read, stop, or be notified about is a second
 * semantics smuggled into the tool, not a degraded version of this one.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { JobsClient, JobsUnavailable } from "./client.ts";

/** Longest command excerpt used as a job label. */
const MAX_LABEL_CHARS = 120;

/** One command to start in the background. */
export interface BackgroundCommandRequest {
	/** Fully composed command (command prefix already applied). */
	command: string;
	cwd: string;
	/** Environment for the job; the gateway merges it over its own. */
	env: NodeJS.ProcessEnv;
	/** Owning session id, sent for owner fencing. */
	owner?: string;
	/** Optional explicit label; defaults to the command's first line. */
	label?: string;
}

/** What a caller needs back: the job id to read or stop later. */
export interface BackgroundCommandStart {
	id: string;
}

/**
 * Starts one background command. Injected into the bash tool so tests (and
 * alternative backends) can replace the gateway without touching tool code.
 */
export type BackgroundCommandStarter = (request: BackgroundCommandRequest) => Promise<BackgroundCommandStart>;

export interface BackgroundCommandDeps {
	/** Descriptor path (tests override this). */
	file?: string;
	fetchImpl?: typeof fetch;
}

/** First line of the command, trimmed and bounded — job labels are one line. */
export function commandLabel(command: string): string {
	const firstLine = command.split("\n").find((line) => line.trim().length > 0) ?? "";
	const trimmed = firstLine.trim();
	return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed;
}

/** JSON-safe copy of an env: process env values may be undefined. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * Start `request.command` as a gateway job of kind `bash`.
 *
 * @throws when the working directory is gone or no gateway is publishing an
 * endpoint; the messages are model-facing, so they say what to do instead.
 */
export async function startBackgroundCommand(
	request: BackgroundCommandRequest,
	deps: BackgroundCommandDeps = {},
): Promise<BackgroundCommandStart> {
	try {
		await access(request.cwd, constants.F_OK);
	} catch {
		throw new Error(`Working directory does not exist: ${request.cwd}\nCannot start a background command.`);
	}

	const client = new JobsClient({
		file: deps.file,
		fetchImpl: deps.fetchImpl,
		session: () => request.owner,
	});
	try {
		const started = await client.start({
			kind: "bash",
			label: request.label ?? commandLabel(request.command),
			cwd: request.cwd,
			cmd: request.command,
			env: stringEnv(request.env),
		});
		return { id: started.id };
	} catch (err) {
		if (err instanceof JobsUnavailable) {
			throw new Error(
				"后台模式不可用：Kalo 网关未运行，无法托管后台任务。请改用前台执行，或自行用 nohup/& 放置进程。",
			);
		}
		throw err;
	}
}

/** Gateway-backed starter — the bash tool's default. */
export const gatewayBackgroundStarter: BackgroundCommandStarter = (request) => startBackgroundCommand(request);
