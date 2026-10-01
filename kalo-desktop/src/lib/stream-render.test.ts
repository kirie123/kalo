import { describe, expect, it } from "vitest";
import {
  STREAM_MARKDOWN_MAX_CHARS,
  STREAM_PARSE_INTERVAL_MS,
  shouldCommitStreamParse,
  shouldStreamAsPlainText,
} from "./stream-render";

describe("shouldStreamAsPlainText", () => {
  it("never degrades a finished block", () => {
    expect(shouldStreamAsPlainText("x".repeat(STREAM_MARKDOWN_MAX_CHARS * 2), false)).toBe(false);
  });

  it("keeps short streams on the Markdown path", () => {
    expect(shouldStreamAsPlainText("短回答", true)).toBe(false);
  });

  it("degrades only past the ceiling", () => {
    expect(shouldStreamAsPlainText("x".repeat(STREAM_MARKDOWN_MAX_CHARS), true)).toBe(false);
    expect(shouldStreamAsPlainText("x".repeat(STREAM_MARKDOWN_MAX_CHARS + 1), true)).toBe(true);
  });
});

describe("shouldCommitStreamParse", () => {
  it("commits the very first frame of a new block", () => {
    expect(shouldCommitStreamParse(0, 1_000_000)).toBe(true);
  });

  it("skips parses inside the window", () => {
    expect(shouldCommitStreamParse(1_000, 1_000 + STREAM_PARSE_INTERVAL_MS - 1)).toBe(false);
  });

  it("commits at the window boundary and beyond", () => {
    expect(shouldCommitStreamParse(1_000, 1_000 + STREAM_PARSE_INTERVAL_MS)).toBe(true);
    expect(shouldCommitStreamParse(1_000, 1_000 + STREAM_PARSE_INTERVAL_MS * 3)).toBe(true);
  });

  it("accepts an explicit interval", () => {
    expect(shouldCommitStreamParse(1_000, 1_050, 50)).toBe(true);
    expect(shouldCommitStreamParse(1_000, 1_049, 50)).toBe(false);
  });
});