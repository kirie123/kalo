import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./html-downgrade";

describe("htmlToMarkdown", () => {
  it("leaves text without tags untouched", () => {
    const text = "普通文本 with 1 < 2 and a > b";
    expect(htmlToMarkdown(text)).toBe(text);
  });

  it("rewrites headings", () => {
    expect(htmlToMarkdown("<h3>SVG 渲染测试 ✓</h3>").trim()).toBe("### SVG 渲染测试 ✓");
    expect(htmlToMarkdown("<h1>a</h1>").trim()).toBe("# a");
  });

  it("rewrites emphasis, strikethrough and line breaks", () => {
    expect(htmlToMarkdown("<b>粗</b> 和 <i>斜</i>").trim()).toBe("**粗** 和 *斜*");
    expect(htmlToMarkdown("<strong>a</strong><em>b</em>").trim()).toBe("**a***b*");
    expect(htmlToMarkdown("<del>没了</del>").trim()).toBe("~~没了~~");
    expect(htmlToMarkdown("一<br>二")).toBe("一  \n二");
  });

  it("rewrites lists, including nesting", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>").trim()).toBe("- a\n- b");
    expect(htmlToMarkdown("<ol><li>a</li><li>b</li></ol>").trim()).toBe("1. a\n2. b");
    expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li></ul>").trim()).toBe("- a\n  \n  - b");
  });

  it("rewrites tables with a header separator", () => {
    const out = htmlToMarkdown("<table><tr><th>年</th><th>营收</th></tr><tr><td>2025</td><td>10</td></tr></table>");
    expect(out.trim().split("\n")).toEqual(["| 年 | 营收 |", "| --- | --- |", "| 2025 | 10 |"]);
  });

  it("escapes pipes inside table cells", () => {
    expect(htmlToMarkdown("<table><tr><td>a|b</td></tr></table>")).toContain("a\\|b");
  });

  it("rewrites blockquotes and rules", () => {
    expect(htmlToMarkdown("<blockquote>引用</blockquote>").trim()).toBe("> 引用");
    expect(htmlToMarkdown("<hr/>").trim()).toBe("---");
  });

  it("rewrites code, decoding entities inside it", () => {
    expect(htmlToMarkdown("<code>a &lt; b</code>").trim()).toBe("`a < b`");
    expect(htmlToMarkdown("<pre><code>x &amp;&amp; y</code></pre>").trim()).toBe("```\nx && y\n```");
  });

  it("keeps safe links and images but strips dangerous urls", () => {
    expect(htmlToMarkdown('<a href="https://x.test">站点</a>').trim()).toBe("[站点](https://x.test)");
    expect(htmlToMarkdown('<img src="https://x.test/a.png" alt="图">').trim()).toBe("![图](https://x.test/a.png)");
    const js = htmlToMarkdown('<a href="javascript:alert(1)">点我</a>').trim();
    expect(js).toBe("点我");
    expect(htmlToMarkdown('<img src="javascript:alert(1)">').trim()).toBe("");
  });

  it("drops script, style and iframe together with their content", () => {
    const out = htmlToMarkdown("<script>alert(1)</script><style>body{}</style><iframe src=x></iframe>正文");
    expect(out.trim()).toBe("正文");
  });

  it("never emits html for tags outside the whitelist", () => {
    // Unknown tags stay visible as source rather than being silently dropped.
    expect(htmlToMarkdown("<custom-thing>x</custom-thing>")).toContain("<custom-thing>");
  });

  it("leaves html inside fenced and inline code alone", () => {
    const fenced = "```html\n<h3>标题</h3>\n```\n";
    expect(htmlToMarkdown(fenced)).toBe(fenced);
    const inlineCode = "写成 `<br>` 就换行";
    expect(htmlToMarkdown(inlineCode)).toBe(inlineCode);
  });

  it("rewrites html around a fence without touching the fence", () => {
    const out = htmlToMarkdown("<b>前</b>\n\n```\n<b>里</b>\n```\n\n<b>后</b>");
    expect(out).toContain("**前**");
    expect(out).toContain("<b>里</b>");
    expect(out).toContain("**后**");
  });

  it("collapses the blank lines it introduces", () => {
    expect(htmlToMarkdown("<p>a</p><p>b</p>")).not.toMatch(/\n{3}/);
  });

  it("drops empty inline wrappers instead of leaving bare markers", () => {
    expect(htmlToMarkdown("<b></b>x").trim()).toBe("x");
    expect(htmlToMarkdown("<span>纯文本</span>").trim()).toBe("纯文本");
  });
});
