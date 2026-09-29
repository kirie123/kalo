import { describe, expect, it } from "vitest";
import { classify, classifyOne } from "../src/extensions/present-files/classify.ts";
import { artifactFileKind } from "../src/extensions/present-files/file-kind.ts";

const CWD = process.platform === "win32" ? "C:\\work\\session" : "/work/session";

describe("classifyOne", () => {
	it("treats http/https as url and derives a name from the last path segment", () => {
		const item = classifyOne("https://example.com/space/d/Report.html", CWD);
		expect(item.kind).toBe("url");
		expect(item.path).toBe("https://example.com/space/d/Report.html");
		expect(item.name).toBe("Report.html");
		expect(item.fileKind).toBeUndefined();
	});

	it("falls back to host when a url has no path", () => {
		expect(classifyOne("https://example.com", CWD).name).toBe("example.com");
	});

	it("resolves a relative file path against cwd and derives fileKind", () => {
		const item = classifyOne("report.html", CWD);
		expect(item.kind).toBe("file");
		expect(item.name).toBe("report.html");
		expect(item.fileKind).toBe("html");
		expect(item.path.startsWith(CWD)).toBe(true);
	});

	it("keeps an absolute file path as-is", () => {
		const abs = process.platform === "win32" ? "C:\\out\\a.md" : "/out/a.md";
		const item = classifyOne(abs, CWD);
		expect(item.kind).toBe("file");
		expect(item.path).toBe(abs);
		expect(item.fileKind).toBe("markdown");
	});
});

describe("classify", () => {
	it("marks only the first entry primary and preserves order", () => {
		const items = classify(["a.html", "b.md", "https://x.io/c"], CWD);
		expect(items.map((i) => i.primary)).toEqual([true, false, false]);
		expect(items.map((i) => i.name)).toEqual(["a.html", "b.md", "c"]);
	});

	it("dedupes by resolved path, first occurrence wins", () => {
		const abs = process.platform === "win32" ? "C:\\work\\session\\a.html" : "/work/session/a.html";
		const items = classify(["a.html", abs, "a.html"], CWD);
		expect(items).toHaveLength(1);
		expect(items[0]?.primary).toBe(true);
	});

	it("drops empty/whitespace entries", () => {
		const items = classify(["", "  ", "a.txt"], CWD);
		expect(items).toHaveLength(1);
		expect(items[0]?.name).toBe("a.txt");
	});

	it("returns an empty list for no usable entries", () => {
		expect(classify(["", "   "], CWD)).toEqual([]);
	});
});

describe("artifactFileKind", () => {
	it("maps extensions to render buckets", () => {
		expect(artifactFileKind("x.html")).toBe("html");
		expect(artifactFileKind("x.htm")).toBe("html");
		expect(artifactFileKind("x.md")).toBe("markdown");
		expect(artifactFileKind("x.svg")).toBe("svg");
		expect(artifactFileKind("x.png")).toBe("image");
		expect(artifactFileKind("x.pdf")).toBe("pdf");
		expect(artifactFileKind("x.docx")).toBe("docx");
		expect(artifactFileKind("x.xlsx")).toBe("xlsx");
		expect(artifactFileKind("x.zip")).toBe("opaque");
		expect(artifactFileKind("x.ts")).toBe("text");
		expect(artifactFileKind("noext")).toBe("text");
	});

	it("is case-insensitive and separator-agnostic", () => {
		expect(artifactFileKind("DIR\\Report.HTML")).toBe("html");
		expect(artifactFileKind("dir/report.MD")).toBe("markdown");
	});
});
