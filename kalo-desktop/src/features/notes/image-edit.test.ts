import { describe, expect, it } from "vitest";
import { deleteAdjacentNoteImage, removeNoteImage } from "./image-edit";
import { splitNote, updateNote } from "./document";

describe("note image keyboard deletion", () => {
  const image = "![照片](<../attachments/a.png>)\n";

  it("backspaces at the beginning of the following empty paragraph", () => {
    const body = `前文\n${image}`;
    expect(deleteAdjacentNoteImage(body, body.length, body.length, "backward")).toEqual({ body: "前文\n", caret: 3 });
  });

  it("allows blank separators while preserving all other bytes", () => {
    const body = `前文\n\n${image}\n\t后文`;
    const caret = body.indexOf("后文");
    expect(deleteAdjacentNoteImage(body, caret, caret, "backward")).toEqual({ body: "前文\n\n\n\t后文", caret: 4 });
  });

  it("deletes forward from the end of the preceding paragraph", () => {
    const body = `前文\n\n${image}后文`;
    expect(deleteAdjacentNoteImage(body, 2, 2, "forward")).toEqual({ body: "前文\n\n后文", caret: 2 });
  });

  it("does not cross intervening text in either direction", () => {
    const body = `前文\n${image}后文`;
    expect(deleteAdjacentNoteImage(body, body.length, body.length, "backward")).toBeNull();
    expect(deleteAdjacentNoteImage(body, 0, 0, "forward")).toBeNull();
  });

  it("preserves native range deletion and rejects invalid positions", () => {
    const body = `${image}文字`;
    expect(deleteAdjacentNoteImage(body, image.length, body.length, "backward")).toBeNull();
    for (const position of [-1, body.length + 1, NaN, 0.5]) {
      expect(deleteAdjacentNoteImage(body, position, position, "backward")).toBeNull();
    }
  });

  it("removes only the nearest image in a consecutive sequence", () => {
    const body = `${image}${image}`;
    expect(deleteAdjacentNoteImage(body, body.length, body.length, "backward")).toEqual({ body: image, caret: image.length });
    expect(deleteAdjacentNoteImage(body, 0, 0, "forward")).toEqual({ body: image, caret: 0 });
  });

  it("removes a selected image without touching text or another image", () => {
    const body = `文字\n${image}保留\n${image}`;
    expect(removeNoteImage(body, 3)).toEqual({ body: `文字\n保留\n${image}`, caret: 3 });
    expect(removeNoteImage(body, 4)).toBeNull();
  });

  it("keeps CRLF text and frontmatter unchanged", () => {
    const header = "---\r\ntitle: 标题\r\n_custom: keep\r\n---\r\n";
    const body = "前文\r\n![图片](C:/images/a.png)\r\n\r\n后文";
    const result = deleteAdjacentNoteImage(body, body.indexOf("后文"), body.indexOf("后文"), "backward")!;
    expect(updateNote(header + body, { body: result.body })).toBe(header + "前文\r\n\r\n后文");
    expect(splitNote(header + result.body).header).toBe(header);
  });

  it("does not interpret inline or fenced images as removable blocks", () => {
    for (const body of ["前文 ![图片](a.png)\n", "```md\n![图片](a.png)\n```\n"]) {
      expect(deleteAdjacentNoteImage(body, body.length, body.length, "backward")).toBeNull();
      expect(removeNoteImage(body, body.indexOf("!["))).toBeNull();
    }
  });
});
