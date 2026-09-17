import { describe, expect, it } from "vitest";
import {
  applyAssets,
  collectLocalAssets,
  dirOf,
  injectBeforeBody,
  joinPath,
  renderDocHtml,
  resolveLocalPath,
  rewriteLinks,
  stripAuthorScripts,
  stripRemoteScripts,
  unresolvedAssets,
  BRIDGE_SCRIPT,
  MAX_ASSETS,
} from "./html-doc";

const DOC = "D:/proj/docs/proposals/PR-25.html";

function inline(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

describe("dirOf / joinPath", () => {
  it("takes the directory off either separator style", () => {
    expect(dirOf(DOC)).toBe("D:/proj/docs/proposals");
    expect(dirOf("C:\\proj\\docs\\a.html")).toBe("C:/proj/docs");
    expect(dirOf("/Users/x/docs/a.html")).toBe("/Users/x/docs");
    expect(dirOf("a.html")).toBe("");
  });

  it("resolves posix-style references", () => {
    expect(joinPath("D:/proj/docs/proposals", "../assets/doc.css")).toBe("D:/proj/docs/assets/doc.css");
    expect(joinPath("D:/proj/docs/proposals", "./figs/a.png")).toBe("D:/proj/docs/proposals/figs/a.png");
    expect(joinPath("D:/proj/docs/proposals", "a/b/../c.png")).toBe("D:/proj/docs/proposals/a/c.png");
    expect(joinPath("D:/proj/docs/proposals", "a\\b.css")).toBe("D:/proj/docs/proposals/a/b.css");
  });

  it("honours absolute references and never climbs past a root", () => {
    expect(joinPath("D:/proj/docs", "/etc/hosts")).toBe("/etc/hosts");
    expect(joinPath("D:/proj/docs", "C:/other/a.css")).toBe("C:/other/a.css");
    expect(joinPath("D:/proj/docs", "../../../../x.css")).toBe("D:/x.css");
    expect(joinPath("D:/docs", "../../../x.css")).toBe("D:/x.css");
    expect(joinPath("/docs", "../../x.css")).toBe("/x.css");
  });
});

describe("resolveLocalPath", () => {
  it("resolves relative and file:// references against the document", () => {
    expect(resolveLocalPath("../assets/doc.css", DOC)).toBe("D:/proj/docs/assets/doc.css");
    expect(resolveLocalPath("doc.css?v=2", DOC)).toBe("D:/proj/docs/proposals/doc.css");
    expect(resolveLocalPath("doc.css#top", DOC)).toBe("D:/proj/docs/proposals/doc.css");
    expect(resolveLocalPath("file:///D:/proj/assets/a.png", DOC)).toBe("D:/proj/assets/a.png");
    expect(resolveLocalPath("file:///home/x/a.png", DOC)).toBe("/home/x/a.png");
  });

  it("rejects anything that is not a local file", () => {
    expect(resolveLocalPath("https://cdn.test/x.css", DOC)).toBeNull();
    expect(resolveLocalPath("data:text/css,body{}", DOC)).toBeNull();
    expect(resolveLocalPath("//cdn.test/x.css", DOC)).toBeNull();
    expect(resolveLocalPath("#anchor", DOC)).toBeNull();
    expect(resolveLocalPath("", DOC)).toBeNull();
  });
});

describe("collectLocalAssets", () => {
  it("finds stylesheets, scripts and images with their source ranges", () => {
    const html = [
      `<link rel="stylesheet" href="../assets/doc.css">`,
      `<script src="../assets/doc.js"></script>`,
      `<img alt="图" src="figs/a.png">`,
    ].join("\n");
    const assets = collectLocalAssets(html, DOC);

    expect(assets.map((a) => [a.kind, a.path])).toEqual([
      ["style", "D:/proj/docs/assets/doc.css"],
      ["script", "D:/proj/docs/assets/doc.js"],
      ["image", "D:/proj/docs/proposals/figs/a.png"],
    ]);
    // Ranges cut the source back out exactly.
    expect(html.slice(assets[0].start, assets[0].end)).toBe(`<link rel="stylesheet" href="../assets/doc.css">`);
    expect(html.slice(assets[1].start, assets[1].end)).toBe(`<script src="../assets/doc.js"></script>`);
    expect(html.slice(assets[2].start, assets[2].end)).toBe(`<img alt="图" src="figs/a.png">`);
  });

  it("keeps a script's pair intact instead of matching the next closing tag", () => {
    const html = `<script src="a.js"/>text<script>inline()</script>`;
    const assets = collectLocalAssets(html, DOC);
    expect(assets).toHaveLength(1);
    expect(html.slice(assets[0].start, assets[0].end)).toBe(`<script src="a.js"/>`);
  });

  it("ignores remote, data: and non-stylesheet references", () => {
    const html = [
      `<link rel="stylesheet" href="https://cdn.test/x.css">`,
      `<link rel="icon" href="../favicon.ico">`,
      `<script src="https://cdn.test/a.js"></script>`,
      `<img src="data:image/png;base64,AAAA">`,
      `<img src="https://img.test/a.png">`,
    ].join("\n");
    expect(collectLocalAssets(html, DOC)).toEqual([]);
  });

  it("carries the media attribute over from the link", () => {
    const [asset] = collectLocalAssets(`<link rel="stylesheet" media="print" href="p.css">`, DOC);
    expect(asset.media).toBe("print");
  });

  it("caps the number of references it reports", () => {
    const html = Array.from({ length: MAX_ASSETS + 5 }, (_v, i) => `<img src="f${i}.png">`).join("");
    expect(collectLocalAssets(html, DOC)).toHaveLength(MAX_ASSETS);
  });
});

describe("applyAssets", () => {
  const html = [
    `<link rel="stylesheet" href="../assets/doc.css">`,
    `<script src="../assets/doc.js"></script>`,
    `<img alt="图" src="figs/a.png">`,
  ].join("\n");
  const assets = collectLocalAssets(html, DOC);
  const payloads = inline([
    ["D:/proj/docs/assets/doc.css", "body{color:red}"],
    ["D:/proj/docs/assets/doc.js", "boot()"],
    ["D:/proj/docs/proposals/figs/a.png", "data:image/png;base64,AAAA"],
  ]);

  it("inlines styles, scripts and images", () => {
    const out = applyAssets(html, assets, payloads, true);
    expect(out).toContain("<style>body{color:red}</style>");
    expect(out).toContain("<script>boot()</script>");
    expect(out).toContain(`<img alt="图" src="data:image/png;base64,AAAA">`);
  });

  it("keeps media on the inlined style", () => {
    const link = `<link rel="stylesheet" media="print" href="p.css">`;
    const out = applyAssets(
      link,
      collectLocalAssets(link, DOC),
      inline([["D:/proj/docs/proposals/p.css", "@page{}"]]),
      true,
    );
    expect(out).toBe(`<style media="print">@page{}</style>`);
  });

  it("drops scripts entirely when scripts are off, and leaves others alone", () => {
    const out = applyAssets(html, assets, payloads, false);
    expect(out).not.toContain("boot()");
    expect(out).not.toContain("<script");
    // Styles and images are still inlined: only scripts are gated.
    expect(out).toContain("<style>body{color:red}</style>");
    expect(out).toContain("data:image/png;base64,AAAA");
  });

  it("leaves an unreadable reference in place rather than deleting it", () => {
    const out = applyAssets(html, assets, inline([["D:/proj/docs/assets/doc.css", "a{}"]]), true);
    expect(out).toContain(`<script src="../assets/doc.js"></script>`);
    expect(out).toContain(`src="figs/a.png"`);
  });

  it("escapes a closing tag hiding inside inlined code", () => {
    const file = `<script src="a.js"></script>`;
    const out = applyAssets(
      file,
      collectLocalAssets(file, DOC),
      inline([["D:/proj/docs/proposals/a.js", `var s = "</script>";`]]),
      true,
    );
    expect(out).toBe(`<script>var s = "<\\/script>";</script>`);
  });

  it("reports the references it could not resolve", () => {
    expect(unresolvedAssets(assets, payloads)).toEqual([]);
    expect(unresolvedAssets(assets, inline([["D:/proj/docs/assets/doc.css", "a{}"]])).map((a) => a.url)).toEqual([
      "../assets/doc.js",
      "figs/a.png",
    ]);
  });
});

describe("stripAuthorScripts", () => {
  it("removes scripts, with or without a closing tag", () => {
    expect(stripAuthorScripts(`<script>alert(1)</script>正文`)).toBe("正文");
    expect(stripAuthorScripts(`<script src="a.js"/>正文`)).toBe("正文");
    expect(stripAuthorScripts(`<script>var a = 1;\nalert(a)</script>`)).toBe("");
  });

  it("removes event handlers in every quoting style", () => {
    expect(stripAuthorScripts(`<img src="a.png" onerror="boom()">`)).toBe(`<img src="a.png">`);
    expect(stripAuthorScripts(`<div onclick='go()' class="x">t</div>`)).toBe(`<div class="x">t</div>`);
    expect(stripAuthorScripts(`<div onclick=go()>t</div>`)).toBe(`<div>t</div>`);
    expect(stripAuthorScripts(`<img src="a.png" onerror>`)).toBe(`<img src="a.png">`);
  });

  it("neutralises javascript: urls, including obfuscated ones", () => {
    expect(stripAuthorScripts(`<a href="javascript:alert(1)">点</a>`)).toBe(`<a href="#">点</a>`);
    expect(stripAuthorScripts(`<a href=" JavaScript:alert(1)">点</a>`)).toBe(`<a href="#">点</a>`);
    expect(stripAuthorScripts(`<a href="java\tscript:alert(1)">点</a>`)).toBe(`<a href="#">点</a>`);
    expect(stripAuthorScripts(`<a href="vbscript:x">点</a>`)).toBe(`<a href="#">点</a>`);
    // Ordinary links are untouched.
    expect(stripAuthorScripts(`<a href="https://x.test">站</a>`)).toBe(`<a href="https://x.test">站</a>`);
  });

  it("drops meta refresh but keeps other metas", () => {
    expect(stripAuthorScripts(`<meta http-equiv="refresh" content="0;url=https://x.test">`)).toBe("");
    expect(stripAuthorScripts(`<meta charset="utf-8">`)).toBe(`<meta charset="utf-8">`);
  });

  it("does not rewrite text or script bodies it is about to remove", () => {
    const html = `<p>写成 onerror= 会怎样</p>`;
    expect(stripAuthorScripts(html)).toBe(html);
    expect(stripAuthorScripts(`<style>.a{content:"onerror=x"}</style>`)).toBe(`<style>.a{content:"onerror=x"}</style>`);
  });
});

describe("stripRemoteScripts", () => {
  it("keeps local and inline scripts, drops remote ones", () => {
    const html = [
      `<script src="a.js"></script>`,
      `<script>inline()</script>`,
      `<script src="https://cdn.test/a.js"></script>`,
      `<script src="//cdn.test/a.js"></script>`,
    ].join("\n");
    const out = stripRemoteScripts(html);
    expect(out).toContain(`<script src="a.js"></script>`);
    expect(out).toContain(`<script>inline()</script>`);
    expect(out).not.toContain("cdn.test");
  });
});

describe("rewriteLinks", () => {
  it("turns a local document link into an inert, tagged link", () => {
    const out = rewriteLinks(`<a href="../features/F09.html">F09</a>`, DOC);
    expect(out).toBe(`<a href="#" data-kalo-doc="D:/proj/docs/features/F09.html">F09</a>`);
  });

  it("keeps fragments and remote links, tagging the latter", () => {
    expect(rewriteLinks(`<a href="#why">why</a>`, DOC)).toBe(`<a href="#why">why</a>`);
    expect(rewriteLinks(`<a href="https://x.test/a">x</a>`, DOC)).toBe(
      `<a href="https://x.test/a" target="_blank" rel="noopener noreferrer">x</a>`,
    );
    expect(rewriteLinks(`<a href="mailto:a@x.test">m</a>`, DOC)).toContain(`target="_blank"`);
  });

  it("does not double up attributes that are already there", () => {
    const out = rewriteLinks(`<a href="https://x.test" target="_blank" rel="noopener">x</a>`, DOC);
    expect(out.match(/target=/g)).toHaveLength(1);
    expect(out.match(/rel=/g)).toHaveLength(1);
  });

  it("leaves anchors without href, and non-anchor tags, alone", () => {
    expect(rewriteLinks(`<a name="top">t</a>`, DOC)).toBe(`<a name="top">t</a>`);
    expect(rewriteLinks(`<img src="a.png">`, DOC)).toBe(`<img src="a.png">`);
  });

  it("does not touch markup-looking text inside scripts", () => {
    const html = `<script>var t = '<a href="../x.html">y</a>';</script>`;
    expect(rewriteLinks(html, DOC)).toBe(html);
  });
});

describe("injectBeforeBody", () => {
  it("inserts before </body> when there is one", () => {
    expect(injectBeforeBody(`<body>hi</body>`, "X")).toBe(`<body>hi<script>X</script></body>`);
  });

  it("appends when the document has no body tag", () => {
    expect(injectBeforeBody(`<p>hi</p>`, "X")).toBe(`<p>hi</p><script>X</script>`);
  });
});

describe("renderDocHtml", () => {
  const html = [
    `<!DOCTYPE html>`,
    `<html><head>`,
    `<link rel="stylesheet" href="../assets/doc.css">`,
    `<script src="../assets/doc.js"></script>`,
    `<script src="https://cdn.test/x.js"></script>`,
    `</head><body class="doc-dark">`,
    `<h1 onclick="boom()">标题</h1>`,
    `<a href="../features/F09.html">F09</a>`,
    `</body></html>`,
  ].join("\n");
  const assets = collectLocalAssets(html, DOC);
  const payloads = inline([
    ["D:/proj/docs/assets/doc.css", "body{background:#111}"],
    ["D:/proj/docs/assets/doc.js", "boot()"],
  ]);

  it("renders a self-contained document with scripts off", () => {
    const out = renderDocHtml(html, DOC, { assets, inline: payloads, allowScripts: false });
    expect(out).toContain("<style>body{background:#111}</style>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("boot()");
    expect(out).not.toContain("onclick");
    expect(out).toContain(`<a href="#" data-kalo-doc="D:/proj/docs/features/F09.html">F09</a>`);
  });

  it("runs local scripts and the bridge when scripts are on, never remote ones", () => {
    const out = renderDocHtml(html, DOC, { assets, inline: payloads, allowScripts: true });
    expect(out).toContain("<script>boot()</script>");
    expect(out).toContain(BRIDGE_SCRIPT);
    expect(out).not.toContain("cdn.test");
    // The bridge is the last script in the document.
    expect(out.indexOf(BRIDGE_SCRIPT)).toBeGreaterThan(out.indexOf("boot()"));
  });

  it("leaves a document that needs nothing from us untouched", () => {
    const plain = `<html><body><p>纯文本</p></body></html>`;
    expect(renderDocHtml(plain, DOC, { assets: [], inline: new Map(), allowScripts: false })).toBe(plain);
  });
});