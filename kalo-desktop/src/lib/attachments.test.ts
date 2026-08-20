import { describe, expect, it } from "vitest";
import { basename, formatAttachmentTag, parseAttachmentTag } from "./attachments";

/** How chat-store joins the typed text and the tag. */
function compose(text: string, paths: string[]): string {
  const tag = formatAttachmentTag(paths);
  return tag ? (text ? `${text}\n\n${tag}` : tag) : text;
}

describe("formatAttachmentTag", () => {
  it("is empty with no paths", () => {
    expect(formatAttachmentTag([])).toBe("");
  });

  it("lists one <file> per path and tells the model to read them", () => {
    const tag = formatAttachmentTag(["D:\\work\\a.md", "D:\\work\\b.pdf"]);
    expect(tag).toContain('<file path="D:\\work\\a.md" />');
    expect(tag).toContain('<file path="D:\\work\\b.pdf" />');
    expect(tag).toContain("read");
    // The whole point: no file contents.
    expect(tag.split("\n")).toHaveLength(5);
  });
});

describe("parseAttachmentTag", () => {
  it("round-trips paths with spaces and non-ASCII names", () => {
    const paths = ["D:\\我的 文档\\报表 (最终).xlsx", "/home/me/notes.md"];
    const parsed = parseAttachmentTag(compose("看看这些", paths));
    expect(parsed.text).toBe("看看这些");
    expect(parsed.paths).toEqual(paths);
  });

  it("leaves a message without the tag alone", () => {
    const msg = "普通消息\n\n第二段";
    expect(parseAttachmentTag(msg)).toEqual({ text: msg, paths: [] });
  });

  it("handles attachments with no typed text", () => {
    const parsed = parseAttachmentTag(compose("", ["C:\\tmp\\x.txt"]));
    expect(parsed.text).toBe("");
    expect(parsed.paths).toEqual(["C:\\tmp\\x.txt"]);
  });

  it("keeps a user-typed <attachments> block as text when it has no <file> entries", () => {
    const msg = "解释一下这个格式：\n\n<attachments>\n随便写的\n</attachments>";
    expect(parseAttachmentTag(msg)).toEqual({ text: msg, paths: [] });
  });

  it("only strips a trailing block, not one in the middle", () => {
    const msg = '<attachments>\nx\n<file path="a" />\n</attachments>\n\n后面还有话';
    expect(parseAttachmentTag(msg)).toEqual({ text: msg, paths: [] });
  });

  it("keeps an `&` in a path verbatim", () => {
    const parsed = parseAttachmentTag(compose("x", ["D:\\a & b\\c.txt"]));
    expect(parsed.paths).toEqual(["D:\\a & b\\c.txt"]);
  });
});

describe("basename", () => {
  it("takes the last segment for either separator", () => {
    expect(basename("D:\\a\\b\\c.txt")).toBe("c.txt");
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("c.txt")).toBe("c.txt");
  });
});
