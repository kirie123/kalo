import { describe, expect, it } from "vitest";
import { imageMarkdown, noteBlocks, noteTitle, replaceNoteRange, resolveNoteImage, splitNote, updateNote } from "./document";

describe("note document editing", () => {
  it("updates only the requested field while preserving unknown metadata and CRLF", () => {
    const original = '---\r\ntitle: "旧标题"\r\n_custom: retain\r\ntags: [研究]\r\n---\r\n\r\n正文\r\n';
    expect(noteTitle(original)).toBe("旧标题");
    expect(updateNote(original, { title: "新标题\n不可注入: yes" })).toBe(original.replace('"旧标题"', "新标题 不可注入: yes"));
    expect(updateNote(original, { body: "新正文" })).toBe(splitNote(original).header + "新正文");
  });

  it("preserves ordinary Markdown and does not treat an unfinished YAML block as metadata", () => {
    const text = "---\n未闭合\n正文";
    expect(splitNote(text)).toEqual({ header: "", body: text });
    expect(updateNote("# old\nbody", { body: "text" })).toBe("text");
    expect(updateNote("body", { title: "$&" })).toBe("---\ntitle: $&\n---\nbody");
  });

  it("extracts standalone pictures without interpreting fenced examples or inline images", () => {
    const body = "开头\n```md\n![例](x.png)\n```\n![照片](<../a%20b.png>)\n结尾 ![内联](b.png)\n";
    const blocks = noteBlocks(body);
    expect(blocks.filter((b) => b.kind === "image")).toEqual([{ kind: "image", start: 25, end: 47, source: "../a%20b.png", alt: "照片" }]);
    expect(blocks.map((b) => body.slice(b.start, b.end)).join("")).toBe(body);
    const image = blocks.find((b) => b.kind === "image")!;
    expect(replaceNoteRange(body, image.start, image.end, "")).toContain("```md\n![例](x.png)\n```");
    expect(noteBlocks("~~~\n![code](x)\n~~~\n").every((b) => b.kind === "text")).toBe(true);
  });

  it("roundtrips escaped local image paths including Windows spaces, parentheses and fragments", () => {
    const path = "C:\\Users\\a b\\笔记(1)#?.png";
    const block = noteBlocks(imageMarkdown(path, "a[b]"))[1];
    expect(block.kind).toBe("image");
    if (block.kind === "image") expect(resolveNoteImage(block.source, "")).toBe(path.replace(/\\/g, "/"));
  });

  it("resolves relative images on macOS, Windows drives and UNC shares", () => {
    expect(resolveNoteImage("../attachments/a%20b.png", "/Users/u/.kalo/knowledge/cards/n.md")).toBe("/Users/u/.kalo/knowledge/attachments/a b.png");
    expect(resolveNoteImage("./images/x.png", "C:\\Users\\u\\notes\\n.md")).toBe("C:/Users/u/notes/images/x.png");
    expect(resolveNoteImage("../img/x.png", "\\\\host\\share\\notes\\n.md")).toBe("//host/share/img/x.png");
    expect(resolveNoteImage("https://example.com/x.png", "/notes/n.md")).toBe("https://example.com/x.png");
    expect(resolveNoteImage("https://example.com/a%23b.png", "/notes/n.md")).toBe("https://example.com/a%23b.png");
  });

  it("allows clearing a title and adds a body after a metadata-only note", () => {
    expect(noteTitle(updateNote("---\ntitle: old\n---\nbody", { title: "" }), "")).toBe("");
    expect(updateNote("---\ntitle: old\n---", { body: "body" })).toBe("---\ntitle: old\n---\nbody");
    expect(noteTitle(updateNote("body", { title: "hello " }))).toBe("hello ");
    expect(updateNote("---\n---\nbody", { title: "hello world" })).toBe("---\ntitle: hello world\n---\nbody");
  });
});
