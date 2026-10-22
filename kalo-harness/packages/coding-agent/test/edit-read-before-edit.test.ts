import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { FileReadState } from "../src/core/tools/file-read-state.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-guard-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ctx = {} as ExtensionContext;

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

describe("read-before-edit guard", () => {
	it("rejects editing a file that was never read this session", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "alpha\nbeta\n", "utf8");
		const readState = new FileReadState();
		const edit = createEditToolDefinition(dir, { readState });

		await expect(
			edit.execute(
				"t1",
				{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/has not been read in this session/);
		// File must be untouched.
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("alpha\nbeta\n");
	});

	it("allows editing after the file was read", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "alpha\nbeta\n", "utf8");
		const readState = new FileReadState();
		const read = createReadToolDefinition(dir, { readState });
		const edit = createEditToolDefinition(dir, { readState });

		await read.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
		const result = await edit.execute(
			"t1",
			{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(firstText(result)).toContain("Successfully replaced");
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("ALPHA\nbeta\n");
	});

	it("allows a second consecutive edit without re-reading", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "alpha\nbeta\n", "utf8");
		const readState = new FileReadState();
		const read = createReadToolDefinition(dir, { readState });
		const edit = createEditToolDefinition(dir, { readState });

		await read.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
		await edit.execute(
			"t1",
			{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			ctx,
		);
		const second = await edit.execute(
			"t2",
			{ path: "a.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(firstText(second)).toContain("Successfully replaced");
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("ALPHA\nBETA\n");
	});

	it("rejects editing after the file changed on disk since the last read", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "alpha\nbeta\n", "utf8");
		const readState = new FileReadState();
		const read = createReadToolDefinition(dir, { readState });
		const edit = createEditToolDefinition(dir, { readState });

		await read.execute("r1", { path: "a.txt" }, undefined, undefined, ctx);
		// External modification after the read.
		await writeFile(join(dir, "a.txt"), "alpha\nGAMMA\n", "utf8");

		await expect(
			edit.execute(
				"t1",
				{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/has changed since it was last read/);
	});

	it("allows editing a file that was just written", async () => {
		const dir = await createTempDir();
		const readState = new FileReadState();
		const write = createWriteToolDefinition(dir, { readState });
		const edit = createEditToolDefinition(dir, { readState });

		await write.execute("w1", { path: "new.txt", content: "one\ntwo\n" }, undefined, undefined, ctx);
		const result = await edit.execute(
			"t1",
			{ path: "new.txt", edits: [{ oldText: "one", newText: "ONE" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(firstText(result)).toContain("Successfully replaced");
		expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("ONE\ntwo\n");
	});

	it("skips the guard entirely when no readState is provided (backward compatible)", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "alpha\n", "utf8");
		const edit = createEditToolDefinition(dir);

		const result = await edit.execute(
			"t1",
			{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(firstText(result)).toContain("Successfully replaced");
	});
});
