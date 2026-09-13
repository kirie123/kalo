import { describe, expect, it } from "vitest";
import { appendAttachment } from "./attachment-intake";
import type { AttachmentDraft } from "../types";

const file = (name: string, path: string): AttachmentDraft => ({ kind: "file", name, path });
const image = (name: string): AttachmentDraft => ({ kind: "image", name, mimeType: "image/png", dataBase64: "AA" });

describe("appendAttachment", () => {
  it("追加新草稿", () => {
    expect(appendAttachment([], file("a.md", "D:/a.md"))).toHaveLength(1);
  });

  it("同一个路径加两次是 no-op（返回原数组）", () => {
    const existing = [file("a.md", "D:/a.md")];
    expect(appendAttachment(existing, file("a.md", "D:/a.md"))).toBe(existing);
  });

  it("重名的图片被改名，不会互相覆盖", () => {
    const next = appendAttachment([image("shot.png")], image("shot.png"));
    expect(next.map((a) => a.name)).toEqual(["shot.png", "shot (2).png"]);
  });
});
