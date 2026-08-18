import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWriteToolDefinition, type WriteToolDetails } from "../src/core/tools/write.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "write-details-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run(dir: string, path: string, content: string): Promise<WriteToolDetails | undefined> {
	const tool = createWriteToolDefinition(dir);
	const result = await tool.execute("call-1", { path, content });
	return result.details;
}

describe("write tool details", () => {
	it("reports a new file as created, with no lines removed", async () => {
		const dir = await tempDir();
		expect(await run(dir, "new.txt", "a\nb\nc\n")).toEqual({ created: true, added: 3, removed: 0 });
	});

	it("reports an overwrite with the previous file's line count", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "old.txt"), "1\n2\n3\n4\n5\n");
		expect(await run(dir, "old.txt", "1\n2\n")).toEqual({ created: false, added: 2, removed: 5 });
	});

	it("counts a file without a trailing newline as one line per line", async () => {
		const dir = await tempDir();
		expect(await run(dir, "bare.txt", "only")).toEqual({ created: true, added: 1, removed: 0 });
		expect(await run(dir, "empty.txt", "")).toEqual({ created: true, added: 0, removed: 0 });
	});

	it("still writes when the previous content cannot be read", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "x.txt"), "old\n");
		const tool = createWriteToolDefinition(dir, {
			operations: {
				writeFile: async () => {},
				mkdir: async () => {},
				readFile: async () => {
					throw new Error("nope");
				},
			},
		});
		const result = await tool.execute("call-1", { path: "x.txt", content: "new\n" });
		// Unknown stats, not a failed write: the text result is unchanged.
		expect(result.details).toEqual({ created: false });
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("reports unknown stats for a backend that cannot read", async () => {
		const dir = await tempDir();
		const tool = createWriteToolDefinition(dir, {
			operations: { writeFile: async () => {}, mkdir: async () => {} },
		});
		const result = await tool.execute("call-1", { path: "remote.txt", content: "a\n" });
		expect(result.details).toEqual({ created: false });
	});
});
