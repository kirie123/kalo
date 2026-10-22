import { describe, expect, it } from "vitest";
import { classifyDeterministicFailure, FailureGuard } from "../src/extensions/subagent/failure-guard.ts";

const schema = (tool: string) =>
	`Validation failed for tool "${tool}":\n  - command: must have required properties command\n\nReceived arguments:\n{}`;
const conflict =
	"run_in_background cannot be combined with timeout: a background job has no timeout. Drop timeout and stop the job with job_kill instead.";
const result = (text: string) => ({ content: [{ type: "text", text }] });

describe("deterministic child failure classification", () => {
	it("recognizes exact schema, old/new background conflict and timeout validation diagnostics", () => {
		expect(classifyDeterministicFailure("read", result(schema("read")))).toBe("schema-validation");
		expect(classifyDeterministicFailure("bash", result(conflict))).toBe("background-timeout-conflict");
		expect(
			classifyDeterministicFailure(
				"bash",
				result(
					"run_in_background cannot be combined with timeout except omitted, null, or 0: a background job has no timeout. Drop timeout or set it to 0, and stop the job with job_kill instead.",
				),
			),
		).toBe("background-timeout-conflict");
		for (const text of [
			"Invalid timeout: must be a finite number of seconds",
			"Invalid timeout: maximum is 2147483.647 seconds",
		]) {
			expect(classifyDeterministicFailure("bash", result(text))).toBe("invalid-timeout");
		}
	});
	it.each([
		"Command exited with code 1",
		"FAIL test: expected 2, received 1",
		"Our servers are currently overloaded. Please try again later.",
		"Command timed out after 60 seconds",
		"Invalid timeout: application configuration",
		`${conflict}\nCommand exited with code 1`,
		`${schema("bash")}\nCommand exited with code 1`,
		`script stderr:\n${schema("bash")}`,
		'Validation failed for tool "bash": not a schema diagnostic',
	])("does not count runtime failures: %s", (text) => {
		expect(classifyDeterministicFailure("bash", result(text))).toBeUndefined();
	});
	it("requires the right tool and text content, ignores images/malformed results", () => {
		expect(classifyDeterministicFailure("read", result(conflict))).toBeUndefined();
		expect(classifyDeterministicFailure("bash", result(schema("read")))).toBeUndefined();
		for (const value of [
			null,
			"Invalid timeout: must be a finite number of seconds",
			{},
			{ content: [null, { type: "image", text: conflict }] },
		]) {
			expect(classifyDeterministicFailure("bash", value)).toBeUndefined();
		}
	});
});

describe("child failure budgets", () => {
	it("trips on three identical failures with nested object keys normalized", () => {
		const guard = new FailureGuard();
		const args = [
			{ command: "x", nested: { a: 1, b: 2 } },
			{ nested: { b: 2, a: 1 }, command: "x" },
		];
		for (let i = 0; i < 3; i++) {
			guard.start(String(i), "bash", args[i % 2]);
			const trip = guard.end(String(i), "bash", result(conflict), true);
			if (i < 2) expect(trip).toBeUndefined();
			else expect(trip).toEqual({ tool: "bash", kind: "background-timeout-conflict", consecutive: 3, identical: 3 });
		}
	});
	it("stops twelve mixed deterministic errors including alternating empty args", () => {
		const guard = new FailureGuard();
		for (let i = 0; i < 12; i++) {
			const tool = i % 2 ? "read" : "bash";
			guard.start(String(i), tool, {});
			const trip = guard.end(String(i), tool, result(schema(tool)), true);
			if (i < 11) expect(trip).toBeUndefined();
			else expect(trip).toMatchObject({ consecutive: 12, identical: 1 });
		}
	});
	it("mixed timeout conflicts and empty args cannot evade the total budget", () => {
		const guard = new FailureGuard();
		for (let i = 0; i < 12; i++) {
			guard.start(String(i), "bash", i % 2 ? {} : { command: "verify", timeout: i, run_in_background: true });
			const trip = guard.end(String(i), "bash", result(i % 2 ? schema("bash") : conflict), true);
			if (i < 11) expect(trip).toBeUndefined();
			else expect(trip?.consecutive).toBe(12);
		}
	});
	it("successful rereads of validation diagnostics never trip the guard", () => {
		const guard = new FailureGuard();
		for (let i = 0; i < 30; i++) {
			guard.start(String(i), "read", { path: "audit.md" });
			expect(guard.end(String(i), "read", result(schema("read")), false)).toBeUndefined();
		}
	});
	it.each([false, true])("success or unknown error resets both counters (isError=%s)", (isError) => {
		const guard = new FailureGuard();
		for (let i = 0; i < 20; i++) {
			guard.start(String(i), "bash", {});
			expect(
				guard.end(
					String(i),
					"bash",
					result(i % 3 === 2 ? "Command exited with code 1" : schema("bash")),
					i % 3 === 2 ? isError : true,
				),
			).toBeUndefined();
		}
	});
	it("preserves array order, string whitespace, types, and missing fields in fingerprints", () => {
		const guard = new FailureGuard();
		const args = [
			{ x: [1, 2] },
			{ x: [2, 1] },
			{ x: "1" },
			{ x: 1 },
			{},
			{ timeout: null },
			{ command: " x" },
			{ command: "x" },
		];
		for (let i = 0; i < args.length; i++) {
			guard.start(String(i), "bash", args[i]);
			expect(guard.end(String(i), "bash", result(schema("bash")), true)).toBeUndefined();
		}
	});
	it("pairs by id, tolerates duplicate results and trips only once for parallel completions", () => {
		const guard = new FailureGuard();
		for (let i = 0; i < 8; i++) guard.start(String(i), "bash", {});
		const trips = [];
		for (const id of ["2", "2", "7", "4", "0", "1", "3", "5", "6"]) {
			const trip = guard.end(id, "bash", result(schema("bash")), true);
			if (trip) trips.push(trip);
		}
		expect(trips).toHaveLength(1);
		expect(trips[0].consecutive).toBe(3);
	});
	it("does not guess absent/mismatched starts, and snapshots arguments at start", () => {
		const guard = new FailureGuard();
		const args = { command: "initial" };
		for (let i = 0; i < 2; i++) {
			guard.start(String(i), "bash", args);
			expect(guard.end(String(i), "bash", result(conflict), true)).toBeUndefined();
		}
		expect(guard.end("missing", "bash", result(conflict), true)).toBeUndefined();
		guard.start("wrong", "read", args);
		expect(guard.end("wrong", "bash", result(conflict), true)).toBeUndefined();
		for (let i = 0; i < 3; i++) {
			args.command = "initial";
			guard.start(`new-${i}`, "bash", args);
			args.command = "changed";
			const trip = guard.end(`new-${i}`, "bash", result(conflict), true);
			if (i < 2) expect(trip).toBeUndefined();
			else expect(trip?.identical).toBe(3);
		}
	});
});
