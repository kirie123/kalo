import { createHash } from "node:crypto";

export type DeterministicFailure = "schema-validation" | "background-timeout-conflict" | "invalid-timeout";
export interface FailureGuardTrip {
	kind: DeterministicFailure;
	tool: string;
	consecutive: number;
	identical: number;
}

/** Preserve JSON meaning; only object key order is irrelevant, including nested keys. */
function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	throw new Error("Non-JSON tool arguments");
}

/** Match only known pre-execution diagnostics, never substring matches in shell output. */
export function classifyDeterministicFailure(tool: string, result: unknown): DeterministicFailure | undefined {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return;
	const text = result.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim()
		.replaceAll("\r\n", "\n");
	const header = `Validation failed for tool "${tool}":\n`;
	const separator = "\n\nReceived arguments:\n";
	const boundary = text.indexOf(separator, header.length);
	if (text.startsWith(header) && boundary >= 0) {
		const errors = text.slice(header.length, boundary);
		if (errors === "Unknown validation error" || errors.split("\n").every((line) => /^ {2}- .+: .+/.test(line))) {
			try {
				JSON.parse(text.slice(boundary + separator.length));
				return "schema-validation";
			} catch {
				// Extra shell output/exit status after the JSON is not a schema rejection.
			}
		}
	}
	if (tool !== "bash") return;
	if (
		/^run_in_background cannot be combined with timeout(?: except omitted, null, or 0)?: a background job has no timeout\. Drop timeout(?: or set it to 0,)? and stop the job with job_kill instead\.$/.test(
			text,
		)
	) {
		return "background-timeout-conflict";
	}
	if (/^Invalid timeout: (?:must be a finite number of seconds|maximum is \d+(?:\.\d+)? seconds)$/.test(text)) {
		return "invalid-timeout";
	}
}

/** One instance per child run. It emits a single decision; runner owns abort and persistence. */
export class FailureGuard {
	private readonly calls = new Map<string, { tool: string; fingerprint?: string }>();
	private readonly completed = new Set<string>();
	private previous: string | undefined;
	private consecutive = 0;
	private identical = 0;
	private tripped = false;

	start(id: string, tool: string, args: unknown): void {
		if (this.tripped || this.completed.has(id) || this.calls.has(id)) return;
		let fingerprint: string | undefined;
		try {
			fingerprint = createHash("sha256").update(canonical(args)).digest("hex");
		} catch {
			// Unserializable input cannot establish identical arguments; total budget still applies.
		}
		this.calls.set(id, { tool, fingerprint });
	}

	end(id: string, tool: string, result: unknown, isError: boolean): FailureGuardTrip | undefined {
		if (this.tripped || this.completed.has(id)) return;
		const call = this.calls.get(id);
		this.calls.delete(id);
		this.completed.add(id);
		const kind = isError && call?.tool === tool ? classifyDeterministicFailure(tool, result) : undefined;
		if (!kind) {
			this.previous = undefined;
			this.consecutive = this.identical = 0;
			return;
		}
		const signature = call?.fingerprint ? JSON.stringify([tool, call.fingerprint, kind]) : undefined;
		this.identical = signature !== undefined && signature === this.previous ? this.identical + 1 : 1;
		this.previous = signature;
		this.consecutive++;
		if (this.identical < 3 && this.consecutive < 12) return;
		this.tripped = true;
		this.calls.clear();
		this.completed.clear();
		return { kind, tool, consecutive: this.consecutive, identical: this.identical };
	}
}
