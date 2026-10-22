import { describe, expect, it } from "vitest";
import { browserTitle, normalizeUrl } from "./browser-url";

describe("normalizeUrl", () => {
  it("returns null for an empty address", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });

  it("assumes http for a bare host", () => {
    expect(normalizeUrl("example.com")).toBe("http://example.com");
    expect(normalizeUrl("example.com/docs")).toBe("http://example.com/docs");
  });

  it("assumes http for host:port — which looks like a scheme but is not", () => {
    // The trap: `localhost:3000` would resolve against the app origin if it
    // were passed through as "a URL with the scheme localhost".
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("127.0.0.1:5173/app")).toBe("http://127.0.0.1:5173/app");
  });

  it("keeps a real scheme untouched", () => {
    expect(normalizeUrl("https://example.com/x?q=1")).toBe("https://example.com/x?q=1");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("file:///C:/tmp/a.html")).toBe("file:///C:/tmp/a.html");
    expect(normalizeUrl("data:text/html,<h1>hi</h1>")).toBe("data:text/html,<h1>hi</h1>");
  });

  it("normalizes a protocol-relative address to https", () => {
    expect(normalizeUrl("//example.com/x")).toBe("https://example.com/x");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUrl("  example.com  ")).toBe("http://example.com");
  });

  it("is case-insensitive about the scheme", () => {
    expect(normalizeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(normalizeUrl("About:blank")).toBe("About:blank");
  });
});

describe("browserTitle", () => {
  it("uses the host, port included", () => {
    expect(browserTitle("http://localhost:3000/app")).toBe("localhost:3000");
    expect(browserTitle("https://example.com")).toBe("example.com");
  });

  it("falls back to 浏览器 without a usable host", () => {
    expect(browserTitle("")).toBe("浏览器");
    expect(browserTitle("about:blank")).toBe("浏览器");
    expect(browserTitle("not a url")).toBe("浏览器");
  });
});