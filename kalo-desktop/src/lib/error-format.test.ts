import { describe, expect, it } from "vitest";
import { formatApiError, isAbortError } from "./error-format";

describe("isAbortError", () => {
  it("recognises the abort messages the engine settles a stopped turn with", () => {
    // Tool-call abort (the case that used to show a red banner).
    expect(isAbortError("The operation was aborted.")).toBe(true);
    expect(isAbortError("The operation was aborted")).toBe(true);
    expect(isAbortError("AbortError: The operation was aborted")).toBe(true);
    expect(isAbortError("Request was aborted")).toBe(true);
    expect(isAbortError("  Error: aborted.  ")).toBe(true);
  });

  it("is false for missing or empty messages", () => {
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("")).toBe(false);
    expect(isAbortError("   ")).toBe(false);
  });

  it("does not swallow real failures that merely mention aborting", () => {
    expect(isAbortError("OpenAI API error (500): upstream aborted the connection")).toBe(false);
    expect(isAbortError("bash: command aborted with exit code 130")).toBe(false);
    expect(isAbortError("The operation was aborted because the disk is full")).toBe(false);
  });
});

describe("formatApiError", () => {
  it("summarises a labeled provider error", () => {
    const parsed = formatApiError('OpenAI API error (429): {"code":"ServerOverloaded","message":"slow down"}');
    expect(parsed.summary).toBe("OpenAI API error (429)：slow down");
    expect(parsed.status).toBe(429);
    expect(parsed.detail).toBeTruthy();
  });

  it("summarises a bare status + json error and drops the request id", () => {
    const parsed = formatApiError('529 {"type":"error","error":{"message":"Overloaded Request id: abc123"}}');
    expect(parsed.summary).toBe("HTTP 529：Overloaded");
    expect(parsed.status).toBe(529);
  });

  it("falls back to the first line, keeping the rest as detail", () => {
    const parsed = formatApiError("boom\nstack line 1\nstack line 2");
    expect(parsed.summary).toBe("boom");
    expect(parsed.detail).toContain("stack line 2");
  });

  it("has no detail when the whole error is the summary", () => {
    expect(formatApiError("boom")).toEqual({ summary: "boom", detail: undefined });
  });
});
