import { describe, expect, it } from "vitest";
import { buildSandboxHtml, sanitizeForIframe, sanitizeForStreaming, scriptLiteral } from "./widget-sandbox";

/** The two ways a widget carries script: an inline block and a CDN <script src>. */
const WIDGET_WITH_SCRIPTS = [
  '<div class="dash"><canvas id="chart"></canvas></div>',
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>',
  '<script>new Chart(document.getElementById("chart"), { type: "line", data: { labels: [], datasets: [] } });</script>',
].join("\n");

/** Everything between the sandbox document's own <script> tags, i.e. the bootstrap. */
function bootstrapOf(doc: string): string {
  const open = doc.indexOf("<script>") + "<script>".length;
  const close = doc.indexOf("</script>");
  return doc.slice(open, close);
}

describe("scriptLiteral", () => {
  it("round-trips the code through the JS parser", () => {
    const code = '<b>a"b\\c</b>\n<script>1</script>';
    expect(JSON.parse(scriptLiteral(code))).toBe(code);
  });

  it("keeps the tokenizer from ending the script element early", () => {
    const literal = scriptLiteral("</script><!--<script>");
    expect(literal).not.toContain("<");
    // The escaped form still decodes back to the same characters.
    expect(JSON.parse(literal)).toBe("</script><!--<script>");
  });
});

describe("buildSandboxHtml", () => {
  const themeVars = { "--cb-text-primary": "#e6e6e6", "--cb-panel-bg-primary": "#1b1b1b" };

  it("keeps a script-carrying widget from truncating the bootstrap", () => {
    const doc = buildSandboxHtml(WIDGET_WITH_SCRIPTS, false, "html", themeVars);
    // One <script> element in the document: the bootstrap itself. The widget's
    // own script tags live inside that script's payload, escaped.
    expect(doc.match(/<script\b/g)).toHaveLength(1);
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
    expect(() => new Function(bootstrapOf(doc))).not.toThrow();
    expect(bootstrapOf(doc)).toContain(scriptLiteral(sanitizeForIframe(WIDGET_WITH_SCRIPTS)));
  });

  it("still renders a widget verbatim once the literal is decoded", () => {
    const doc = buildSandboxHtml(WIDGET_WITH_SCRIPTS, false, "html", themeVars);
    const literal = bootstrapOf(doc).match(/renderHtml\((".*?"), true\)/s)?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal!)).toContain('<script src="https://cdnjs.cloudflare.com/');
  });

  it("carries the loader that turns external scripts into real requests", () => {
    // innerHTML never runs <script src>, so the bootstrap re-creates it and waits.
    const doc = buildSandboxHtml(WIDGET_WITH_SCRIPTS, false, "html", themeVars);
    expect(bootstrapOf(doc)).toContain("getAttribute('src')");
    expect(bootstrapOf(doc)).toContain("ext.onload");
  });

  it("embeds SVG widgets as a literal too", () => {
    const svg = '<svg viewBox="0 0 680 120"><text x="8" y="60">hi</text></svg>';
    const doc = buildSandboxHtml(svg, false, "svg", themeVars);
    expect(doc.match(/<script\b/g)).toHaveLength(1);
    expect(doc).toContain(`root.innerHTML = ${scriptLiteral(svg)};`);
  });

  it("injects the host theme tokens and the CDN allowlist into the CSP", () => {
    const doc = buildSandboxHtml("<p>hi</p>", false, "html", themeVars);
    expect(doc).toContain("--cb-text-primary: #e6e6e6;");
    expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdnjs.cloudflare.com");
    expect(doc).toContain("connect-src https://cdnjs.cloudflare.com");
  });

  it("escapes a streaming payload the same way", () => {
    const doc = buildSandboxHtml(WIDGET_WITH_SCRIPTS, true, "html", themeVars);
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
    expect(() => new Function(bootstrapOf(doc))).not.toThrow();
  });
});

describe("sanitizeForStreaming", () => {
  it("removes script and dangerous tags", () => {
    const out = sanitizeForStreaming(
      '<p>a</p><script>bad()</script><iframe src="https://x"></iframe><form><input></form><meta http-equiv="refresh" content="0">',
    );
    expect(out).toBe("<p>a</p>");
  });

  it("tolerates a half-open document", () => {
    expect(sanitizeForStreaming('<div class="a"><p>partial')).toBe('<div class="a"><p>partial');
    // An unterminated <script> tail is hidden rather than shown as text.
    expect(sanitizeForStreaming('<div>a</div><script>var x =')).toContain("display:none!important");
  });

  it("strips inline handlers and javascript: URLs", () => {
    const out = sanitizeForStreaming('<a href="javascript:evil()" onclick="evil()">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("onclick");
    expect(out).toContain('<a href="');
  });
});

describe("sanitizeForIframe", () => {
  it("keeps scripts but drops the dangerous tags", () => {
    const out = sanitizeForIframe('<script src="https://cdnjs.cloudflare.com/x.js"></script><base href="x"><p>k</p>');
    expect(out).toContain('<script src="https://cdnjs.cloudflare.com/x.js"></script>');
    expect(out).not.toContain("<base");
    expect(out).toBe('<script src="https://cdnjs.cloudflare.com/x.js"></script><p>k</p>');
  });

  it("leaves safe sources alone", () => {
    const html = '<img src="data:image/png;base64,AAA"><script src="https://unpkg.com/x.js"></script>';
    expect(sanitizeForIframe(html)).toBe(html);
  });

  it("neutralizes javascript: schemes", () => {
    const out = sanitizeForIframe('<a href="javascript:evil()">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("x</a>");
  });
});