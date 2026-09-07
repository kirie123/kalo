import { describe, expect, it } from "vitest";
import type { AssistantEntry, RetryEntry, TimelineEntry } from "./chat-store";
import { applyRetryEnd, applyRetryStart, pushAssistantEntry } from "./retry-fold";

function failedAssistant(id: string): AssistantEntry {
  return {
    id,
    kind: "assistant",
    streaming: false,
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Connection error.",
      timestamp: 0,
    } as AssistantEntry["message"],
  };
}

const start = (attempt: number) => ({
  attempt,
  maxAttempts: 3,
  delayMs: 2000,
  errorMessage: "Connection error.",
});

describe("applyRetryStart", () => {
  it("marks the trailing failed assistant message and pushes one retry entry", () => {
    const t: TimelineEntry[] = [failedAssistant("a1")];
    applyRetryStart(t, start(1), "r1");
    expect((t[0] as AssistantEntry).retriedError).toBe(true);
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ kind: "retry", attempt: 1, maxAttempts: 3 });
  });

  it("updates the open retry entry in place on the next attempt", () => {
    const t: TimelineEntry[] = [failedAssistant("a1")];
    applyRetryStart(t, start(1), "r1");
    t.push(failedAssistant("a2"));
    applyRetryStart(t, start(2), "r2");
    const retries = t.filter((e) => e.kind === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ id: "r1", attempt: 2 });
    expect((t[2] as AssistantEntry).retriedError).toBe(true);
  });

  it("starts a new entry once the previous sequence is done", () => {
    const t: TimelineEntry[] = [];
    applyRetryStart(t, start(1), "r1");
    applyRetryEnd(t, { success: true });
    applyRetryStart(t, start(1), "r2");
    const retries = t.filter((e) => e.kind === "retry") as RetryEntry[];
    expect(retries).toHaveLength(2);
    expect(retries[0].done).toEqual({ success: true, finalError: undefined });
  });
});

describe("applyRetryEnd", () => {
  it("closes the open entry and folds the final error into the retry line", () => {
    const t: TimelineEntry[] = [];
    applyRetryStart(t, start(3), "r1");
    t.push(failedAssistant("a1"));
    applyRetryEnd(t, { success: false, finalError: "Connection error." });
    expect((t[1] as AssistantEntry).retriedError).toBe(true);
    expect(t[0]).toMatchObject({ done: { success: false, finalError: "Connection error." } });
  });

  it("keeps a non-error trailing assistant message untouched", () => {
    const ok: AssistantEntry = {
      id: "a1",
      kind: "assistant",
      streaming: false,
      message: { role: "assistant", content: [], stopReason: "stop", timestamp: 0 } as AssistantEntry["message"],
    };
    const t: TimelineEntry[] = [ok];
    applyRetryStart(t, start(1), "r1");
    expect((t[0] as AssistantEntry).retriedError).toBeUndefined();
  });
});

describe("pushAssistantEntry", () => {
  const err = (msg = "Connection error.") =>
    ({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: msg,
      timestamp: 0,
    }) as AssistantEntry["message"];

  it("folds a run of identical persisted errors into the latest one", () => {
    const t: TimelineEntry[] = [];
    pushAssistantEntry(t, err(), "a1");
    pushAssistantEntry(t, err(), "a2");
    pushAssistantEntry(t, err(), "a3");
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe("a3");
  });

  it("does not fold different errors or errors with visible content", () => {
    const t: TimelineEntry[] = [];
    pushAssistantEntry(t, err("Connection error."), "a1");
    pushAssistantEntry(t, err("Rate limited"), "a2");
    const withText = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: "Connection error.",
      timestamp: 0,
    } as AssistantEntry["message"];
    pushAssistantEntry(t, withText, "a3");
    expect(t).toHaveLength(3);
  });
});
