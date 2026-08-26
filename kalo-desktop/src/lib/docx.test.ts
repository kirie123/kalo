import { describe, expect, it } from "vitest";
import { docxToMarkdown, headingLevel } from "./docx";
import { buildZip } from "./zip-fixture";
import { openZip } from "./zip";

const DOC_OPEN =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
const DOC_CLOSE = "</w:body></w:document>";

/** Build a one-part docx around a body fragment. */
function docx(body: string, extra: Record<string, string> = {}) {
  return openZip(buildZip({ "word/document.xml": DOC_OPEN + body + DOC_CLOSE, ...extra }));
}

const run = (text: string, props = "") => `<w:r>${props}<w:t>${text}</w:t></w:r>`;
const para = (text: string, pPr = "") => `<w:p>${pPr}${run(text)}</w:p>`;
const style = (id: string) => `<w:pPr><w:pStyle w:val="${id}"/></w:pPr>`;

describe("headingLevel", () => {
  it("recognizes English, numeric and localized style ids", () => {
    expect(headingLevel("Heading1")).toBe(1);
    expect(headingLevel("Heading 3")).toBe(3);
    expect(headingLevel("标题 2")).toBe(2);
    expect(headingLevel("2")).toBe(2);
    expect(headingLevel("Title")).toBe(1);
  });

  it("clamps beyond h6 and rejects non-headings", () => {
    expect(headingLevel("Heading9")).toBe(6);
    expect(headingLevel("BodyText")).toBe(0);
    expect(headingLevel(undefined)).toBe(0);
  });
});

describe("docxToMarkdown", () => {
  it("maps headings and paragraphs to markdown blocks", async () => {
    const { markdown } = await docxToMarkdown(
      docx(para("迈瑞医疗财报精读", style("Heading1")) + para("营收下滑 9.4%。")),
    );
    expect(markdown).toBe("# 迈瑞医疗财报精读\n\n营收下滑 9.4%。");
  });

  it("applies bold and italic outside the surrounding spaces", async () => {
    const body = `<w:p>${run("净利 ")}${run("-30.3%", "<w:rPr><w:b/></w:rPr>")}${run(" 同比", "<w:rPr><w:i/></w:rPr>")}</w:p>`;
    const { markdown } = await docxToMarkdown(docx(body));
    expect(markdown).toBe("净利 **-30.3%** *同比*");
  });

  it("honours an explicitly disabled bold run", async () => {
    const body = `<w:p>${run("plain", '<w:rPr><w:b w:val="0"/></w:rPr>')}</w:p>`;
    expect((await docxToMarkdown(docx(body))).markdown).toBe("plain");
  });

  it("escapes markdown syntax coming from the document text", async () => {
    const { markdown } = await docxToMarkdown(docx(para("a_b *c* [d] | e") + para("- 不是列表")));
    expect(markdown).toBe("a\\_b \\*c\\* \\[d\\] \\| e\n\n\\- 不是列表");
  });

  it("keeps consecutive list items in one list, indented by level", async () => {
    const bullet = (text: string, ilvl = 0) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`;
    const { markdown } = await docxToMarkdown(docx(bullet("一") + bullet("一.一", 1) + bullet("二")));
    expect(markdown).toBe("- 一\n  - 一.一\n- 二");
  });

  it("uses ordered markers when numbering.xml says so", async () => {
    const numbering =
      '<?xml version="1.0"?><w:numbering xmlns:w="x">' +
      '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
      '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>';
    const body = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>${run("第一步")}</w:p>`;
    const { markdown } = await docxToMarkdown(docx(body, { "word/numbering.xml": numbering }));
    expect(markdown).toBe("1. 第一步");
  });

  it("renders a table as GFM, padding short rows", async () => {
    const cell = (t: string) => `<w:tc>${para(t)}</w:tc>`;
    const body =
      "<w:tbl>" +
      `<w:tr>${cell("指标")}${cell("2025A")}</w:tr>` +
      `<w:tr>${cell("营收")}${cell("332.8")}</w:tr>` +
      `<w:tr>${cell("净利")}</w:tr>` +
      "</w:tbl>";
    const { markdown } = await docxToMarkdown(docx(body));
    expect(markdown).toBe(
      "| 指标 | 2025A |\n| --- | --- |\n| 营收 | 332.8 |\n| 净利 |  |",
    );
  });

  it("resolves hyperlinks through the rels part", async () => {
    const rels =
      '<?xml version="1.0"?><Relationships xmlns="x">' +
      '<Relationship Id="rId5" Target="https://example.com/q"/></Relationships>';
    const body = `<w:p><w:hyperlink r:id="rId5">${run("年报")}</w:hyperlink></w:p>`;
    const { markdown } = await docxToMarkdown(docx(body, { "word/_rels/document.xml.rels": rels }));
    expect(markdown).toBe("[年报](https://example.com/q)");
  });

  it("leaves a hyperlink without a target as plain text", async () => {
    const body = `<w:p><w:hyperlink w:anchor="top">${run("回到顶部")}</w:hyperlink></w:p>`;
    expect((await docxToMarkdown(docx(body))).markdown).toBe("回到顶部");
  });

  it("keeps insertions, drops deletions, and counts images", async () => {
    const body =
      `<w:p><w:ins>${run("新增")}</w:ins><w:del>${run("删除")}</w:del>${run("保留")}</w:p>` +
      `<w:p><w:r><w:drawing><w:pic/></w:drawing></w:r>${run("图注")}</w:p>`;
    const { markdown, imageCount } = await docxToMarkdown(docx(body));
    expect(markdown).toBe("新增保留\n\n图注");
    expect(imageCount).toBe(1);
  });

  it("turns tabs and breaks into markdown whitespace", async () => {
    const body = `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`;
    expect((await docxToMarkdown(docx(body))).markdown).toBe("a  b  \nc");
  });

  it("skips empty paragraphs rather than emitting blank blocks", async () => {
    const { markdown } = await docxToMarkdown(docx(para("one") + "<w:p/>" + para("two")));
    expect(markdown).toBe("one\n\ntwo");
  });

  it("fails with a readable message when the main part is missing", async () => {
    const zip = openZip(buildZip({ "docProps/app.xml": "<x/>" }));
    await expect(docxToMarkdown(zip)).rejects.toThrow(/word\/document\.xml/);
  });
});
