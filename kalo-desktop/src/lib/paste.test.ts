import { describe, expect, it } from "vitest";
import { attachmentPathKey, clipboardUriPaths, shouldAttachPastedText } from "./paste";

describe("clipboard decisions", () => {
  it("attaches a single paste at 6000 UTF-16 units, including whitespace", () => {
    expect(shouldAttachPastedText("中".repeat(5999))).toBe(false);
    expect(shouldAttachPastedText("中".repeat(6000))).toBe(true);
    expect(shouldAttachPastedText("a".repeat(6001))).toBe(true);
    expect(shouldAttachPastedText("😀".repeat(3000))).toBe(true);
    expect(shouldAttachPastedText(" ".repeat(6000))).toBe(true);
    expect(shouldAttachPastedText("a".repeat(6000), true)).toBe(false);
  });
  it("decodes local file URIs without treating ordinary text as a file", () => {
    expect(clipboardUriPaths("# files\nfile:///C:/a%20b/%E4%B8%AD.txt\nhttps://example.com/a\nfile:///C:/a%20b/%E4%B8%AD.txt"))
      .toEqual(["C:/a b/中.txt"]);
    expect(clipboardUriPaths("file://server/share/a.txt\nfile://localhost/Users/me/a\nfile:///bad%ZZ"))
      .toEqual(["//server/share/a.txt", "/Users/me/a"]);
    expect(clipboardUriPaths("C:\\a.txt")).toEqual([]);
  });
  it("deduplicates Windows spelling without folding POSIX case", () => {
    expect(attachmentPathKey("C:\\Files\\A.txt")).toBe(attachmentPathKey("c:/files/a.txt"));
    expect(attachmentPathKey("/Users/me/A")).not.toBe(attachmentPathKey("/Users/me/a"));
  });
});
