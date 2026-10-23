import { describe, expect, it } from "vitest";
import { NoteSaveQueue } from "./save-queue";

describe("note save ordering", () => {
  it("never lets an earlier slow write overwrite newer content", async () => {
    const writes: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const queue = new NoteSaveQueue(async ({ text }) => {
      if (text === "old") await blocked;
      writes.push(text);
    });
    const first = queue.enqueue({ path: "a", text: "old" });
    const second = queue.enqueue({ path: "a", text: "new" });
    await Promise.resolve();
    expect(writes).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual(["old", "new"]);
    await queue.enqueue({ path: "a", text: "new" });
    expect(writes).toEqual(["old", "new"]);
  });

  it("allows retry after failure and drains writes for different notes before deletion", async () => {
    let attempt = 0;
    const writes: string[] = [];
    const queue = new NoteSaveQueue(async ({ path }) => {
      if (++attempt === 1) throw new Error("disk full");
      writes.push(path);
    });
    await expect(queue.enqueue({ path: "a", text: "draft" })).rejects.toThrow("disk full");
    const retry = queue.enqueue({ path: "a", text: "draft" });
    const other = queue.enqueue({ path: "b", text: "other" });
    await queue.idle();
    await Promise.all([retry, other]);
    expect(writes).toEqual(["a", "b"]);
  });

  it("invalidates a completed snapshot when a note is reread after external edits", async () => {
    const writes: string[] = [];
    const queue = new NoteSaveQueue(async ({ text }) => { writes.push(text); });
    await queue.enqueue({ path: "a", text: "old" });
    queue.forget("a");
    await queue.enqueue({ path: "a", text: "old" });
    expect(writes).toEqual(["old", "old"]);
  });
});
