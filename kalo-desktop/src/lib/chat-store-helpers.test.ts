import { describe, expect, it } from "vitest";
import {
  errText,
  normPath,
  pastedImageName,
  promptTitle,
  sameFlags,
  samePending,
  uniqueAttachmentName,
} from "./chat-store-helpers";
import type { AttachmentDraft, PendingSession } from "../types";

describe("normPath", () => {
  it("normalizes Windows separators and case for pool keys", () => {
    expect(normPath("D:\\Project\\App")).toBe("d:/project/app");
    expect(normPath("D:/project/app")).toBe("d:/project/app");
  });
});

describe("sameFlags", () => {
  it("compares keys and values", () => {
    expect(sameFlags({ a: true }, { a: true })).toBe(true);
    expect(sameFlags({ a: true }, { a: false })).toBe(false);
    expect(sameFlags({ a: true }, { a: true, b: true })).toBe(false);
  });
});

describe("samePending", () => {
  const row = (path: string): PendingSession => ({ path, id: "1", title: "t", cwd: "c" }) as PendingSession;

  it("is field-wise, not identity-based", () => {
    expect(samePending([row("a")], [row("a")])).toBe(true);
    expect(samePending([row("a")], [row("b")])).toBe(false);
    expect(samePending([row("a")], [])).toBe(false);
  });
});

describe("promptTitle", () => {
  it("uses the first non-empty line", () => {
    expect(promptTitle("\n\n  hello\nworld")).toBe("hello");
  });

  it("falls back for an empty prompt", () => {
    expect(promptTitle("   \n  ")).toBe("新对话");
  });

  it("truncates a long line", () => {
    const title = promptTitle("x".repeat(120));
    expect(title).toHaveLength(81);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("uniqueAttachmentName", () => {
  const drafts = (...names: string[]): AttachmentDraft[] => names.map((name) => ({ name }) as AttachmentDraft);

  it("keeps a free name unchanged", () => {
    expect(uniqueAttachmentName("a.png", drafts("b.png"))).toBe("a.png");
  });

  it("suffixes before the extension on collision", () => {
    expect(uniqueAttachmentName("a.png", drafts("a.png"))).toBe("a (2).png");
    expect(uniqueAttachmentName("a.png", drafts("a.png", "a (2).png"))).toBe("a (3).png");
  });

  it("handles names without an extension", () => {
    expect(uniqueAttachmentName("notes", drafts("notes"))).toBe("notes (2)");
  });
});

describe("pastedImageName", () => {
  it("labels a nameless clipboard bitmap", () => {
    const file = { name: "image.png", type: "image/png" } as File;
    expect(pastedImageName(file)).toMatch(/^粘贴图片-\d+\.png$/);
  });

  it("keeps a real file name", () => {
    const file = { name: "diagram.svg", type: "image/svg+xml" } as File;
    expect(pastedImageName(file)).toBe("diagram.svg");
  });
});

describe("errText", () => {
  it("prefers an Error's message", () => {
    expect(errText(new Error("boom"))).toBe("boom");
    expect(errText("plain")).toBe("plain");
  });
});
