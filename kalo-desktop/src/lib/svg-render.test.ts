import { describe, expect, it } from "vitest";
import {
  hasOwnBackdrop,
  idPrefix,
  namespaceIds,
  sanitizeSvg,
  splitSvgSegments,
  suggestSvgFileName,
} from "./svg-render";

describe("splitSvgSegments", () => {
  it("returns the text untouched when there is no svg", () => {
    expect(splitSvgSegments("# hi\n\nplain *text*")).toEqual([{ type: "markdown", text: "# hi\n\nplain *text*" }]);
  });

  it("carves an inline svg out of the surrounding prose", () => {
    const segments = splitSvgSegments('before\n<svg width="10"><rect/></svg>\nafter');
    expect(segments.map((s) => s.type)).toEqual(["markdown", "svg", "markdown"]);
    expect(segments[1]).toMatchObject({ source: '<svg width="10"><rect/></svg>', complete: true });
    expect(segments[2]).toMatchObject({ text: "\nafter" });
  });

  it("keeps svg inside fenced code as source", () => {
    const text = "```html\n<svg><rect/></svg>\n```\n";
    expect(splitSvgSegments(text)).toEqual([{ type: "markdown", text }]);
  });

  it("keeps svg inside an inline code span as source", () => {
    const text = "用 `<svg>` 标签，像 `<svg><rect/></svg>` 这样";
    expect(splitSvgSegments(text)).toEqual([{ type: "markdown", text }]);
  });

  it("handles several figures in one message", () => {
    const segments = splitSvgSegments("<svg><a/></svg> mid <svg><b/></svg>");
    expect(segments.map((s) => s.type)).toEqual(["svg", "markdown", "svg"]);
  });

  it("treats a nested svg as part of the outer figure", () => {
    const segments = splitSvgSegments("<svg><svg><rect/></svg></svg>tail");
    expect(segments[0]).toMatchObject({ type: "svg", source: "<svg><svg><rect/></svg></svg>", complete: true });
    expect(segments[1]).toMatchObject({ type: "markdown", text: "tail" });
  });

  it("marks an unterminated figure as incomplete while streaming", () => {
    const segments = splitSvgSegments('text\n<svg width="10"><rec');
    expect(segments[1]).toMatchObject({ type: "svg", complete: false });
  });

  it("does not treat <svgfoo> as a figure", () => {
    const text = "<svgfoo>not a tag</svgfoo>";
    expect(splitSvgSegments(text)).toEqual([{ type: "markdown", text }]);
  });
});

describe("sanitizeSvg", () => {
  it("drops script elements, including an unterminated one", () => {
    expect(sanitizeSvg("<svg><script>alert(1)</script><rect/></svg>")).not.toContain("script");
    expect(sanitizeSvg("<svg><script>alert(1)<rect/></svg>")).not.toContain("script");
  });

  it("drops event handlers in any quoting style", () => {
    const out = sanitizeSvg(`<svg onload="bad()"><rect onclick='bad()' onmouseover=bad()/></svg>`)!;
    expect(out).not.toMatch(/onload|onclick|onmouseover/i);
    expect(out).toContain("<rect");
  });

  it("drops foreignObject", () => {
    expect(sanitizeSvg("<svg><foreignObject><b>hi</b></foreignObject></svg>")).not.toMatch(/foreignObject/i);
  });

  it("keeps fragment and data-image refs but drops network and javascript refs", () => {
    const out = sanitizeSvg(
      '<svg><use href="#a"/><image href="data:image/png;base64,AA"/>' +
        '<image href="https://x.test/a.png"/><a xlink:href="javascript:alert(1)"/></svg>',
    )!;
    expect(out).toContain('href="#a"');
    expect(out).toContain("data:image/png;base64,AA");
    expect(out).not.toContain("https://x.test");
    expect(out).not.toMatch(/javascript:/i);
  });

  it("strips doctype, entity declarations and comments", () => {
    const out = sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><!-- c --><svg><rect/></svg>')!;
    expect(out).not.toMatch(/DOCTYPE|ENTITY|<!--/);
    expect(out.startsWith("<svg")).toBe(true);
  });

  it("returns null for oversized or rootless input", () => {
    expect(sanitizeSvg(`<svg>${"x".repeat(300 * 1024)}</svg>`)).toBeNull();
    expect(sanitizeSvg("<rect/>")).toBeNull();
  });
});

describe("namespaceIds", () => {
  it("rewrites ids together with their references", () => {
    const out = namespaceIds('<svg><linearGradient id="g1"/><rect fill="url(#g1)"/><use href="#g1"/></svg>', "s1");
    expect(out).toContain('id="s1-g1"');
    expect(out).toContain("url(#s1-g1)");
    expect(out).toContain('href="#s1-g1"');
    expect(out).not.toMatch(/#g1\b/);
  });

  it("leaves svg without ids alone", () => {
    const svg = "<svg><rect/></svg>";
    expect(namespaceIds(svg, "s1")).toBe(svg);
  });

  it("gives the same prefix for the same source and different ones otherwise", () => {
    expect(idPrefix("<svg><a/></svg>")).toBe(idPrefix("<svg><a/></svg>"));
    expect(idPrefix("<svg><a/></svg>")).not.toBe(idPrefix("<svg><b/></svg>"));
  });

  it("namespaces through sanitizeSvg so two figures cannot collide", () => {
    const a = sanitizeSvg('<svg><linearGradient id="g"/><rect fill="url(#g)"/></svg>')!;
    const b = sanitizeSvg('<svg><linearGradient id="g"/><circle fill="url(#g)"/></svg>')!;
    const idOf = (s: string) => /id="([^"]+)"/.exec(s)![1];
    expect(idOf(a)).not.toBe(idOf(b));
  });
});

describe("hasOwnBackdrop", () => {
  it("detects a full-bleed rect covering the viewBox", () => {
    const svg = '<svg viewBox="0 0 320 140"><rect x="0" y="0" width="320" height="140" fill="#101418"/></svg>';
    expect(hasOwnBackdrop(svg)).toBe(true);
  });

  it("falls back to width/height when there is no viewBox", () => {
    expect(hasOwnBackdrop('<svg width="100" height="50"><rect width="100" height="50" fill="#000"/></svg>')).toBe(
      true,
    );
  });

  it("ignores small shapes and unfilled rects", () => {
    expect(hasOwnBackdrop('<svg viewBox="0 0 320 140"><rect width="40" height="20" fill="#f00"/></svg>')).toBe(false);
    expect(
      hasOwnBackdrop('<svg viewBox="0 0 320 140"><rect width="320" height="140" fill="none" stroke="#f00"/></svg>'),
    ).toBe(false);
  });

  it("honours a background declared on the root element", () => {
    expect(hasOwnBackdrop('<svg viewBox="0 0 10 10" style="background:#111"><circle r="2"/></svg>')).toBe(true);
  });

  it("says no for a transparent figure", () => {
    expect(hasOwnBackdrop('<svg viewBox="0 0 10 10"><path d="M0 0L10 10" stroke="#000"/></svg>')).toBe(false);
  });
});

describe("suggestSvgFileName", () => {
  it("uses the title when present and falls back otherwise", () => {
    expect(suggestSvgFileName("<svg><title>营收 拆解</title></svg>")).toBe("营收-拆解.svg");
    expect(suggestSvgFileName("<svg><rect/></svg>")).toBe("figure.svg");
  });

  it("strips characters that are illegal in windows file names", () => {
    expect(suggestSvgFileName("<svg><title>a/b:c*d?</title></svg>")).toBe("abcd.svg");
  });
});
