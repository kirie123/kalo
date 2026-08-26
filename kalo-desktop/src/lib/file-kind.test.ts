import { describe, expect, it } from "vitest";
import { fileKind, extensionOf, formatBytes, needsBytes } from "./file-kind";
import { buildZip } from "./zip-fixture";
import { openZip } from "./zip";

describe("extensionOf", () => {
  it("takes the last extension of the base name", () => {
    expect(extensionOf("C:/dir.v2/report.final.MD")).toBe("md");
    expect(extensionOf("/a/b/notes.txt")).toBe("txt");
  });

  it("treats a dotfile as having no extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("C:\\repo\\.env")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });
});

describe("fileKind", () => {
  it("routes the formats the preview renders", () => {
    expect(fileKind("a/b/巴菲特Checklist.md")).toBe("markdown");
    expect(fileKind("chart.PNG")).toBe("image");
    expect(fileKind("report.docx")).toBe("docx");
    expect(fileKind("book.xlsm")).toBe("xlsx");
    expect(fileKind("paper.pdf")).toBe("pdf");
  });

  it("sends legacy Office and archives to the opaque branch", () => {
    // OLE compound files, not OOXML zips: the docx/xlsx readers cannot help.
    expect(fileKind("old.doc")).toBe("opaque");
    expect(fileKind("old.xls")).toBe("opaque");
    expect(fileKind("bundle.zip")).toBe("opaque");
  });

  it("defaults to text, including for source and svg", () => {
    expect(fileKind("main.rs")).toBe("text");
    expect(fileKind("icon.svg")).toBe("text");
    expect(fileKind("Makefile")).toBe("text");
  });
});

describe("needsBytes", () => {
  it("marks exactly the kinds that cannot be read as text", () => {
    expect(["image", "docx", "xlsx", "pdf"].every((k) => needsBytes(k as never))).toBe(true);
    expect(["markdown", "text", "opaque"].some((k) => needsBytes(k as never))).toBe(false);
  });
});

describe("formatBytes", () => {
  it("scales the unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("openZip", () => {
  it("reads stored entries back", async () => {
    const zip = openZip(buildZip({ "a.txt": "hello", "dir/b.txt": "世界" }));
    expect(zip.names).toEqual(["a.txt", "dir/b.txt"]);
    expect(zip.has("a.txt")).toBe(true);
    expect(await zip.textOf("a.txt")).toBe("hello");
    expect(await zip.textOf("dir/b.txt")).toBe("世界");
    expect(zip.find((n) => n.startsWith("dir/"))).toBe("dir/b.txt");
  });

  it("rejects input with no end-of-central-directory record", () => {
    expect(() => openZip(new TextEncoder().encode("not a zip at all, really"))).toThrow(/压缩包/);
  });

  it("rejects a too-short buffer", () => {
    expect(() => openZip(new Uint8Array(4))).toThrow(/过小/);
  });

  it("reports a missing entry by name", async () => {
    const zip = openZip(buildZip({ "a.txt": "x" }));
    await expect(zip.bytesOf("nope.txt")).rejects.toThrow(/nope\.txt/);
  });

  it("finds the EOCD even with a trailing comment", async () => {
    const base = buildZip({ "a.txt": "hi" });
    const withComment = new Uint8Array(base.length + 5);
    withComment.set(base);
    // Comment length lives in the last two bytes of the EOCD.
    new DataView(withComment.buffer).setUint16(base.length - 2, 5, true);
    withComment.set(new TextEncoder().encode("note!"), base.length);
    const zip = openZip(withComment);
    expect(await zip.textOf("a.txt")).toBe("hi");
  });
});
