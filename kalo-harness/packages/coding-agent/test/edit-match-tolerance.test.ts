import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, normalizeToLF } from "../src/core/tools/edit-diff.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-tolerance-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("edit match tolerance strategies", () => {
	it("matches trimmed indentation and keeps untouched lines byte-identical", () => {
		const content = "function foo() {\n    return 1;\n}\n";
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "function foo() {\n  return 1;\n}", newText: "function foo() {\n  return 2;\n}" }],
			"f.ts",
		);

		expect(result.matchedWith).toBe("trimmed");
		expect(result.newContent).toBe("function foo() {\n  return 2;\n}\n");
	});

	it("tolerates tabs on the file side and spaces in the old text", () => {
		const content = "alpha\n\tbeta\n";
		const result = applyEditsToNormalizedContent(content, [{ oldText: "  beta", newText: "BETA" }], "tabs.txt");

		expect(result.matchedWith).toBe("trimmed");
		expect(result.newContent).toBe("alpha\nBETA\n");
	});

	it("collapses internal whitespace differences on whole lines", () => {
		const content = "const a  =  b;\nkeep me\n";
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "const a = b;", newText: "const a = c;" }],
			"ws.ts",
		);

		expect(result.matchedWith).toBe("whitespace");
		expect(result.newContent).toBe("const a = c;\nkeep me\n");
	});

	it("uses block anchors when the middle of a multi-line edit drifted", () => {
		const content = "class Foo {\n  bar() {\n    return 1;\n  }\n}\n";
		const result = applyEditsToNormalizedContent(
			content,
			[
				{
					oldText: "class Foo {\n  bar() {\n    return 2;\n  }\n}",
					newText: "class Foo {\n  bar() {\n    return 3;\n  }\n}",
				},
			],
			"anchor.ts",
		);

		expect(result.matchedWith).toBe("anchored");
		expect(result.newContent).toBe("class Foo {\n  bar() {\n    return 3;\n  }\n}\n");
	});

	it("rejects a block anchor whose middle is too different", () => {
		const content = "start\nmiddle one\nmiddle two\nend\n";

		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: "start\nAAA BBB CCC DDD\nEEE FFF GGG HHH\nend", newText: "replacement" }],
				"anchor-miss.txt",
			),
		).toThrowError(/Could not find the exact text/);
	});

	it("reports duplicates found through trimmed matching", () => {
		const content = "\t\talpha\n\t\talpha\n";

		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "    alpha", newText: "x" }], "dups.txt"),
		).toThrowError(/Found 2 occurrences/);
	});

	it("prefers an exact match over a whitespace-variant elsewhere", () => {
		const content = "let value = 1;\nlet  value  =  1;\n";
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "let value = 1;", newText: "let other = 2;" }],
			"prefer.txt",
		);

		expect(result.matchedWith).toBe("exact");
		expect(result.newContent).toBe("let other = 2;\nlet  value  =  1;\n");
	});

	it("does not apply whole-line strategies to a fragment inside a longer line", () => {
		const content = 'const s = "a  b"; // keep the comment\n';

		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: 'const s = "a b";', newText: 'const s = "c";' }],
				"frag.ts",
			),
		).toThrowError(/Could not find the exact text/);
	});

	it("applies exact and trimmed edits together in the trimmed space", () => {
		const content = "alpha\n\tbeta\n";
		const result = applyEditsToNormalizedContent(
			content,
			[
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "  beta", newText: "BETA" },
			],
			"mixed.txt",
		);

		expect(result.matchedWith).toBe("trimmed");
		expect(result.newContent).toBe("ALPHA\nBETA\n");
	});

	it("keeps fuzzy matching for quotes and special spaces", () => {
		const content = normalizeToLF("console.log(\u2018hello\u2019);\nhello\u00A0world\n");
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "console.log('hello');\nhello world\n", newText: "console.log('bye');\nhello world\n" }],
			"fuzzy.ts",
		);

		expect(result.matchedWith).toBe("fuzzy");
		expect(result.newContent).toBe("console.log('bye');\nhello world\n");
	});
});

describe("edit success message annotation", () => {
	it("keeps the plain message for exact matches and annotates approximate ones", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "exact.txt"), "alpha\n", "utf8");
		await writeFile(join(dir, "approx.txt"), "\tbeta\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const exact = await definition.execute(
			"tool-1",
			{ path: "exact.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(getText(exact)).toBe("Successfully replaced 1 block(s) in exact.txt.");

		const approximate = await definition.execute(
			"tool-2",
			{ path: "approx.txt", edits: [{ oldText: "  beta", newText: "BETA" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(getText(approximate)).toBe(
			"Successfully replaced 1 block(s) in approx.txt. (approximate match: indentation-insensitive)",
		);
	});
});
