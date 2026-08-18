/**
 * Client for the kalo gateway's jobs endpoint.
 *
 * The jobs themselves live in the gateway sidecar (they must outlive this
 * session), and the gateway's stdio already belongs to the desktop's NDJSON
 * protocol — so the registry is reached over a loopback HTTP endpoint whose
 * url + token the gateway publishes to ~/.kalo/agent/jobs/endpoint.json.
 *
 * The descriptor is re-read per request on purpose: the gateway restarts with
 * a new port and token, and a session outlives those restarts.
 *
 * Everything here is transport. Owner fencing lives in the gateway: we only
 * present our session id in `x-kalo-session`, and a foreign job comes back as
 * "unknown job".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";

/** One job as the gateway projects it (mirrors gateway/src/jobs/types.ts). */
export interface JobSnapshot {
	id: string;
	kind: string;
	label: string;
	ownerSession?: string;
	status: "queued" | "running" | "stopping" | "completed" | "killed" | "failed";
	detail?: string;
	startedAt: number;
	finishedAt?: number;
	reported: boolean;
}

export interface JobsEndpoint {
	url: string;
	token: string;
	pid: number;
}

export function endpointFile(): string {
	return join(homedir(), CONFIG_DIR_NAME, "agent", "jobs", "endpoint.json");
}

/** Read the published descriptor, or null when no gateway is running. */
export function readEndpoint(file: string = endpointFile()): JobsEndpoint | null {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (typeof raw?.url !== "string" || typeof raw?.token !== "string") return null;
		return { url: raw.url, token: raw.token, pid: Number(raw.pid) || 0 };
	} catch {
		return null;
	}
}

/** Thrown when no gateway endpoint is published — the tools then say so plainly. */
export class JobsUnavailable extends Error {
	constructor() {
		super("后台任务服务不可用（Kalo 网关未运行）");
		this.name = "JobsUnavailable";
	}
}

export interface JobsClientDeps {
	/** Owning session id, sent as `x-kalo-session`; undefined = anonymous. */
	session?: () => string | undefined;
	/** Descriptor path (tests override this). */
	file?: string;
	fetchImpl?: typeof fetch;
}

export class JobsClient {
	private readonly deps: JobsClientDeps;

	constructor(deps: JobsClientDeps = {}) {
		this.deps = deps;
	}

	/** True when a gateway is publishing an endpoint right now. */
	available(): boolean {
		return readEndpoint(this.deps.file) !== null;
	}

	list(): Promise<JobSnapshot[]> {
		return this.request<{ jobs: JobSnapshot[] }>("GET", "/jobs").then((r) => r.jobs);
	}

	get(id: string): Promise<JobSnapshot> {
		return this.request<{ job: JobSnapshot }>("GET", `/jobs/${encodeURIComponent(id)}`).then((r) => r.job);
	}

	output(id: string, opts?: { wait?: boolean; timeoutMs?: number }): Promise<{ text: string; job: JobSnapshot }> {
		return this.request("POST", `/jobs/${encodeURIComponent(id)}/output`, {
			wait: opts?.wait ?? false,
			timeoutMs: opts?.timeoutMs,
		});
	}

	kill(id: string, reason?: string): Promise<{ result: string; job: JobSnapshot }> {
		return this.request("POST", `/jobs/${encodeURIComponent(id)}/kill`, { reason });
	}

	/**
	 * Drain terminal jobs this session has not been told about. The gateway
	 * marks them reported in the same pass, so each completion notifies once.
	 */
	claimCompletions(): Promise<JobSnapshot[]> {
		return this.request<{ jobs: JobSnapshot[] }>("POST", "/completions/claim", {}).then((r) => r.jobs);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const ep = readEndpoint(this.deps.file);
		if (!ep) throw new JobsUnavailable();
		const doFetch = this.deps.fetchImpl ?? fetch;
		const session = this.deps.session?.();
		const res = await doFetch(`${ep.url}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${ep.token}`,
				"content-type": "application/json",
				...(session ? { "x-kalo-session": session } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		let parsed: any;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`网关返回了无法解析的响应（${res.status}）`);
		}
		// The gateway sends user-facing messages as {error}; surface them verbatim.
		if (!res.ok) throw new Error(parsed?.error ? String(parsed.error) : `网关返回 ${res.status}`);
		return parsed as T;
	}
}
