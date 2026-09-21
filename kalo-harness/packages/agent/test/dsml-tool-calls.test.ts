import { describe, expect, it } from "vitest";
import { findThinkingChannelToolNames, findUnexecutedThinkingChannelToolCalls } from "../src/dsml-tool-calls.ts";

// The marker uses the fullwidth vertical bar (U+FF5C) between "DSML" and the tag.
const bar = "\uff5c";

describe("findThinkingChannelToolNames", () => {
	it("detects narrated invokes with and without a space after the marker", () => {
		expect(findThinkingChannelToolNames(`<${bar}DSML${bar} invoke name="write">`)).toEqual(["write"]);
		expect(findThinkingChannelToolNames(`<${bar}DSML${bar}invoke name="bash">`)).toEqual(["bash"]);
	});

	it("detects the ASCII pipe variant some proxies normalize to", () => {
		expect(findThinkingChannelToolNames('<|DSML| invoke name="read">')).toEqual(["read"]);
	});

	it("returns each narrated tool once", () => {
		const thinking = [
			`<${bar}DSML${bar} invoke name="edit">`,
			`<${bar}DSML${bar} parameter name="path" string="true">a.ts`,
			`<${bar}DSML${bar} invoke name="edit">`,
		].join("\n");
		expect(findThinkingChannelToolNames(thinking)).toEqual(["edit"]);
	});

	it("ignores ordinary reasoning and commands", () => {
		expect(findThinkingChannelToolNames("I will use the write tool to create the file.")).toEqual([]);
		expect(findThinkingChannelToolNames("run grep -n 'invoke name=\"write\"' src/")).toEqual([]);
	});

	it("ignores marker-shaped text inside fenced code blocks", () => {
		const thinking = ["Here is the markup I saw:", "```", `<${bar}DSML${bar} invoke name="write">`, "```"].join("\n");
		expect(findThinkingChannelToolNames(thinking)).toEqual([]);
	});

	it("ignores invokes without a name attribute", () => {
		expect(findThinkingChannelToolNames(`<${bar}DSML${bar} invoke>`)).toEqual([]);
	});
});

describe("findUnexecutedThinkingChannelToolCalls", () => {
	const registered = new Set(["write", "bash", "edit"]);

	it("reports only names that are registered and not executed", () => {
		expect(
			findUnexecutedThinkingChannelToolCalls(["write", "bash", "unknown"], new Set(["bash"]), registered),
		).toEqual(["write"]);
	});

	it("is empty when every narrated call was executed for real", () => {
		expect(findUnexecutedThinkingChannelToolCalls(["write"], new Set(["write"]), registered)).toEqual([]);
	});

	it("is empty when nothing was narrated", () => {
		expect(findUnexecutedThinkingChannelToolCalls([], new Set(), registered)).toEqual([]);
	});
});
