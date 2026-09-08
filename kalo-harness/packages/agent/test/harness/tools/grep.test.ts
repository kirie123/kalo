import { describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/harness/tools/grep.ts";

describe("grep tool", () => {
	const tool = createGrepTool();

	describe("prepareArguments", () => {
		const prepare = tool.prepareArguments!;

		it("should pass through pattern when provided", () => {
			const result = prepare({ pattern: "foo" });
			expect(result).toEqual({ pattern: "foo" });
		});

		it("should map query to pattern when pattern is missing", () => {
			const result = prepare({ query: "bar" });
			expect(result).toEqual({ query: "bar", pattern: "bar" });
		});

		it("should prefer pattern over query when both are present", () => {
			const result = prepare({ pattern: "foo", query: "bar" });
			expect(result).toEqual({ pattern: "foo", query: "bar" });
		});

		it("should preserve other arguments", () => {
			const result = prepare({
				query: "test",
				path: "./src",
				glob: "*.ts",
				ignoreCase: true,
				limit: 50,
			});
			expect(result).toEqual({
				query: "test",
				pattern: "test",
				path: "./src",
				glob: "*.ts",
				ignoreCase: true,
				limit: 50,
			});
		});

		it("should return unchanged when neither pattern nor query provided", () => {
			const result = prepare({ path: "./src" });
			expect(result).toEqual({ path: "./src" });
		});
	});
});
