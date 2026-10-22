import { describe, expect, it } from "vitest";
import { capToolOutput, contentText } from "./tool-output";

describe("capToolOutput", () => {
  it("leaves short output untouched", () => {
    const text = "line one\nline two\n";
    const out = capToolOutput(text);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(text);
    expect(out.hiddenChars).toBe(0);
    expect(out.hiddenLines).toBe(0);
  });

  it("leaves output exactly at the limits untouched", () => {
    const text = "x".repeat(100);
    const out = capToolOutput(text, { maxChars: 100, maxLines: 1 });
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(text);
  });

  it("keeps head and tail of a character-heavy result", () => {
    const text = `${"a".repeat(5000)}\n${"b".repeat(5000)}\n${"c".repeat(5000)}`;
    const out = capToolOutput(text, { maxChars: 4000 });
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("a")).toBe(true);
    expect(out.text.endsWith("c")).toBe(true);
    expect(out.text).toContain("已省略");
    // The window never exceeds the budget plus the one marker line.
    expect(out.text.length).toBeLessThan(4000 + 60);
    // Head + tail are exactly `hiddenChars` short of the original; the rest of
    // the rendered text is the single marker line.
    const marker = out.text.length - (text.length - out.hiddenChars);
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(60);
  });

  it("honours the line budget for many short lines", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const out = capToolOutput(text, { maxChars: 20_000, maxLines: 400 });
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("line 0")).toBe(true);
    expect(out.text.endsWith("line 999")).toBe(true);
    expect(out.hiddenLines).toBe(600);
    // Whole lines only, minus the single marker line.
    expect(out.text.split("\n").length).toBe(401);
  });

  it("handles a single line longer than the whole budget", () => {
    const text = "z".repeat(50_000);
    const out = capToolOutput(text, { maxChars: 1000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeGreaterThan(1000);
    expect(out.hiddenChars).toBe(50_000 - 1000);
  });

  it("reports dropped characters and lines consistently", () => {
    const text = Array.from({ length: 50 }, (_, i) => `${i}: ${"y".repeat(200)}`).join("\n");
    const out = capToolOutput(text, { maxChars: 2000, maxLines: 20 });
    const kept = text.length - out.hiddenChars;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(text.length);
    expect(out.hiddenLines).toBeGreaterThan(0);
    expect(out.hiddenLines).toBeLessThan(50);
  });

  it("treats empty output as within limits", () => {
    const out = capToolOutput("");
    expect(out.truncated).toBe(false);
    expect(out.text).toBe("");
  });
});

describe("contentText", () => {
  it("returns empty for nullish input", () => {
    expect(contentText(null)).toBe("");
    expect(contentText(undefined)).toBe("");
  });

  it("passes a plain string through", () => {
    expect(contentText("ps aux output\nsecond line")).toBe("ps aux output\nsecond line");
  });

  it("joins the text blocks of a content array", () => {
    const result = {
      content: [
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
    };
    expect(contentText(result)).toBe("第一段\n第二段");
  });

  it("ignores non-text blocks", () => {
    const result = {
      content: [
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "text", text: "看图" },
      ],
    };
    expect(contentText(result)).toBe("看图");
  });

  it("renders an empty content array as empty text, not JSON", () => {
    // The bug that motivated this helper: a running bash's partial result is
    // `{content: []}`, and `JSON.stringify` leaked it into the tool row.
    expect(contentText({ content: [] })).toBe("");
  });

  it("returns empty for shapes without a content array", () => {
    expect(contentText({ details: { exitCode: 1 } })).toBe("");
    expect(contentText(42)).toBe("");
  });
});