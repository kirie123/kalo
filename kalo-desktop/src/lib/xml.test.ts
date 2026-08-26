import { describe, expect, it } from "vitest";
import { attr, decodeEntities, deepText, element, elements, parseXml, path, rootOf } from "./xml";

describe("parseXml", () => {
  it("builds a tree with attributes and text", () => {
    const root = rootOf(parseXml(`<?xml version="1.0"?><a x="1"><b y="2">hi</b><b>there</b></a>`));
    expect(root?.name).toBe("a");
    expect(attr(root, "x")).toBe("1");
    const bs = elements(root, "b");
    expect(bs).toHaveLength(2);
    expect(bs[0].text).toBe("hi");
    expect(attr(bs[0], "y")).toBe("2");
  });

  it("handles self-closing tags without opening a scope", () => {
    const root = rootOf(parseXml(`<a><b/><c>x</c></a>`));
    expect(elements(root, "b")).toHaveLength(1);
    expect(element(root, "c")?.text).toBe("x");
  });

  it("finds prefixed attributes by local name, exact match first", () => {
    const root = rootOf(parseXml(`<w:p w:val="prefixed" r="plain"/>`));
    expect(attr(root, "val")).toBe("prefixed");
    expect(attr(root, "r")).toBe("plain");
    expect(root?.local).toBe("p");
  });

  it("decodes entities in text and attributes", () => {
    const root = rootOf(parseXml(`<a t="a&amp;b&#65;"> &lt;x&gt; &#x4e2d;</a>`));
    expect(attr(root, "t")).toBe("a&bA");
    expect(root?.text).toBe(" <x> 中");
  });

  it("keeps a > inside a quoted attribute inside the tag", () => {
    const root = rootOf(parseXml(`<a t="1 > 0"><b/></a>`));
    expect(attr(root, "t")).toBe("1 > 0");
    expect(elements(root, "b")).toHaveLength(1);
  });

  it("skips comments, CDATA markers and the prolog", () => {
    const root = rootOf(parseXml(`<a><!-- note --><b><![CDATA[<raw>]]></b></a>`));
    expect(element(root, "b")?.text).toBe("<raw>");
  });

  it("returns a partial tree for a truncated document", () => {
    const root = rootOf(parseXml(`<a><b>one</b><c>two`));
    expect(element(root, "b")?.text).toBe("one");
    expect(element(root, "c")?.text).toBe("two");
  });

  it("ignores an unmatched close tag instead of unwinding", () => {
    const root = rootOf(parseXml(`<a></zz><b>kept</b></a>`));
    expect(element(root, "b")?.text).toBe("kept");
  });

  it("walks a path of local names and collects deep text", () => {
    const root = rootOf(parseXml(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Hi</w:t></w:r></w:p>`));
    expect(attr(path(root, "pPr", "pStyle"), "val")).toBe("Heading2");
    expect(deepText(root)).toBe("Hi");
    expect(path(root, "pPr", "nope")).toBeNull();
  });

  it("can skip subtrees while collecting text", () => {
    const root = rootOf(parseXml(`<p><t>keep</t><del><t>drop</t></del></p>`));
    expect(deepText(root, (c) => c.local === "del")).toBe("keep");
  });
});

describe("decodeEntities", () => {
  it("leaves unknown and out-of-range references alone", () => {
    expect(decodeEntities("&unknown; &#1114112;")).toBe("&unknown; &#1114112;");
  });
});
