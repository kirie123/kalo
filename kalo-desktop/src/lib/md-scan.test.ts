import { describe, expect, it } from "vitest";
import { mapOutsideCode, plainRanges } from "./md-scan";

const slice = (text: string) => plainRanges(text).map((r) => text.slice(r.start, r.end));

describe("plainRanges", () => {
  it("returns the whole text when there is no code", () => {
    expect(slice("abc")).toEqual(["abc"]);
  });

  it("excludes fenced blocks", () => {
    expect(slice("a\n```\ncode\n```\nb")).toEqual(["a\n", "b"]);
  });

  it("excludes tilde fences and indented fences", () => {
    expect(slice("a\n~~~\ncode\n~~~\nb")).toEqual(["a\n", "b"]);
    expect(slice("a\n  ```\ncode\n  ```\nb")).toEqual(["a\n", "b"]);
  });

  it("keeps an unterminated fence closed to the end", () => {
    expect(slice("a\n```\ncode forever")).toEqual(["a\n"]);
  });

  it("excludes inline code spans, including double backticks", () => {
    expect(slice("a `x` b")).toEqual(["a ", " b"]);
    expect(slice("a ``x`y`` b")).toEqual(["a ", " b"]);
  });

  it("treats an unmatched backtick as literal text", () => {
    expect(slice("a ` b").join("")).toBe("a  b");
  });
});

describe("mapOutsideCode", () => {
  it("transforms only the non-code parts", () => {
    const out = mapOutsideCode("a\n```\na\n```\na `a` a", (s) => s.toUpperCase());
    expect(out).toBe("A\n```\na\n```\nA `a` A");
  });

  it("is a no-op when everything is code", () => {
    const text = "```\nonly code\n```\n";
    expect(mapOutsideCode(text, () => "X")).toBe(text);
  });
});
