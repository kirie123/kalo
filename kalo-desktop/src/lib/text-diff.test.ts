import { describe, expect, it } from "vitest";
import { parseDiff } from "../components/DiffView";
import { diffText } from "./text-diff";

describe("diffText", () => {
  it("is empty for identical text", () => {
    expect(diffText("a\nb", "a\nb")).toBe("");
  });

  it("marks a replaced line as one delete and one add", () => {
    const lines = parseDiff(diffText("a\nb\nc", "a\nB\nc"));
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["b"]);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["B"]);
    expect(lines.filter((l) => l.kind === "ctx")).toHaveLength(2);
  });

  it("collapses runs of unchanged lines the DiffView way", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 20", "CHANGED");
    const lines = parseDiff(diffText(a, b, { context: 2 }));
    expect(lines.some((l) => l.kind === "skip")).toBe(true);
    // Only the window around the change survives, not all 40 lines.
    expect(lines.length).toBeLessThan(15);
  });

  it("handles one side being empty", () => {
    const lines = parseDiff(diffText("", "x\ny"));
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["x", "y"]);
  });

  it("numbers added lines by their position in the new text", () => {
    const lines = parseDiff(diffText("a\nc", "a\nb\nc"));
    const add = lines.find((l) => l.kind === "add");
    expect(add?.newNo).toBe(2);
  });
});
