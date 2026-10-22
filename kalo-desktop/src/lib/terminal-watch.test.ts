import { describe, expect, it } from "vitest";
import { watchFeed, watchText } from "./terminal-watch";

describe("watchFeed", () => {
  it("writes nothing when the snapshot is unchanged", () => {
    expect(watchFeed("abc", "abc")).toBeNull();
  });

  it("appends the delta while the rolling tail keeps growing", () => {
    expect(watchFeed("abc", "abcdef")).toEqual({ mode: "append", text: "def" });
  });

  it("treats the first snapshot as an append onto empty output", () => {
    expect(watchFeed("", "hello")).toEqual({ mode: "append", text: "hello" });
  });

  it("resets once the tail evicts old bytes from the front", () => {
    // The engine's accumulator caps the tail length: the new snapshot is no
    // longer an extension of the old one, so splicing the "difference" would
    // glue two unrelated strings together.
    expect(watchFeed("bcdef", "cdefg")).toEqual({ mode: "reset", text: "cdefg" });
  });

  it("resets when the settled result replaces the partial", () => {
    expect(watchFeed("partial output", "final output")).toEqual({ mode: "reset", text: "final output" });
  });

  it("resets when output shrinks", () => {
    expect(watchFeed("abcdef", "ab")).toEqual({ mode: "reset", text: "ab" });
  });
});

describe("watchText", () => {
  it("returns empty for a missing snapshot", () => {
    expect(watchText(undefined)).toBe("");
  });

  it("prefers the settled result (it carries the truncation footer)", () => {
    const text = watchText({
      status: "success",
      partialResult: { content: [{ type: "text", text: "partial" }] },
      result: { content: [{ type: "text", text: "final" }] },
    });
    expect(text).toBe("final");
  });

  it("falls back to the partial while running", () => {
    const text = watchText({
      status: "running",
      partialResult: { content: [{ type: "text", text: "building…" }] },
    });
    expect(text).toBe("building…");
  });

  it("joins several text blocks with newlines", () => {
    const text = watchText({
      status: "running",
      partialResult: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    });
    expect(text).toBe("a\nb");
  });

  it("renders an empty content array as empty text, not JSON", () => {
    expect(watchText({ status: "running", partialResult: { content: [] } })).toBe("");
  });

  it("handles a plain string result", () => {
    expect(watchText({ status: "success", result: "done" })).toBe("done");
  });
});