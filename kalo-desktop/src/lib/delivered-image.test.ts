import { describe, expect, it } from "vitest";
import { markdownImageSource, resolveImageSource } from "./delivered-image";

describe("delivered image sources", () => {
  it("reverses Markdown URI encoding only for local paths", () => {
    expect(resolveImageSource(markdownImageSource("C:%5CUsers%5Cmy%20images/a.png"))).toEqual({ kind: "local", path: "C:\\Users\\my images/a.png" });
    expect(markdownImageSource("/Users/me/my%20images/a.png")).toBe("/Users/me/my images/a.png");
    expect(markdownImageSource("https://example.com/my%20images/a.png")).toBe("https://example.com/my%20images/a.png");
    expect(markdownImageSource("file:///C:/my%20images/a.png")).toBe("file:///C:/my%20images/a.png");
  });
  it.each(["C:/图片/a.png", "D:\\输出\\a.png", "/Users/me/a.png", "\\\\server\\share\\a.png"])("preserves absolute path %s", (path) => {
    expect(resolveImageSource(path)).toEqual({ kind: "local", path });
  });
  it("decodes file URLs without corrupting literal filesystem percent signs", () => {
    expect(resolveImageSource("file:///C:/my%20images/a.png")).toEqual({ kind: "local", path: "C:/my images/a.png" });
    expect(resolveImageSource("file:///Users/me/a%23b.png")).toEqual({ kind: "local", path: "/Users/me/a#b.png" });
    expect(resolveImageSource("file://server/share/a.png")).toEqual({ kind: "local", path: "//server/share/a.png" });
    expect(resolveImageSource("/tmp/100%20.png")).toEqual({ kind: "local", path: "/tmp/100%20.png" });
  });
  it.each(["javascript:alert(1)", "data:text/html;base64,AA==", "data:image/svg+xml;base64,AA==", "./a.png", "C:relative.png", "file:///tmp/a%00.png", "file:///tmp/%zz", ""])("rejects unsafe or ambiguous source %s", (source) => {
    expect(resolveImageSource(source)).toBeNull();
  });
  it("allows web and raster data images", () => {
    expect(resolveImageSource("https://example.com/a.png")?.kind).toBe("url");
    expect(resolveImageSource("data:image/png;base64,AA==")?.kind).toBe("url");
  });
});
