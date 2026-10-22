import { describe, expect, it, vi } from "vitest";
import {
  clearToolWatch,
  getToolWatch,
  publishBashWatch,
  publishToolWatch,
  seedToolWatch,
  subscribeToolWatch,
} from "./tool-watch-registry";

describe("seedToolWatch", () => {
  it("stores the snapshot the row already had", () => {
    seedToolWatch("seed-1", { status: "running", partialResult: { content: [] } });
    expect(getToolWatch("seed-1")).toEqual({ status: "running", partialResult: { content: [] } });
  });

  it("never overwrites a live entry with stale row data", () => {
    publishToolWatch("seed-2", { status: "running", partialResult: { content: [{ type: "text", text: "live" }] } });
    seedToolWatch("seed-2", { status: "success", result: "stale history" });
    expect(getToolWatch("seed-2")?.partialResult).toEqual({ content: [{ type: "text", text: "live" }] });
  });

  it("notifies subscribers so a fresh tab paints immediately", () => {
    const seen = vi.fn();
    const off = subscribeToolWatch(seen);
    seedToolWatch("seed-3", { status: "running" });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("publishToolWatch", () => {
  it("creates a running entry when the call was never seen", () => {
    publishToolWatch("pub-1", { partialResult: "x" });
    expect(getToolWatch("pub-1")).toEqual({ status: "running", partialResult: "x" });
  });

  it("merges a partial update over the previous snapshot", () => {
    publishToolWatch("pub-2", { status: "running", partialResult: "a" });
    publishToolWatch("pub-2", { partialResult: "ab" });
    expect(getToolWatch("pub-2")).toEqual({ status: "running", partialResult: "ab" });
  });

  it("keeps the partial when the call settles", () => {
    publishToolWatch("pub-3", { status: "running", partialResult: "partial" });
    publishToolWatch("pub-3", { status: "success", result: "final" });
    const snap = getToolWatch("pub-3");
    expect(snap?.status).toBe("success");
    expect(snap?.partialResult).toBe("partial");
    expect(snap?.result).toBe("final");
  });

  it("replaces the object identity so React sees the change", () => {
    publishToolWatch("pub-4", { partialResult: "a" });
    const before = getToolWatch("pub-4");
    publishToolWatch("pub-4", { partialResult: "ab" });
    expect(getToolWatch("pub-4")).not.toBe(before);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeToolWatch(seen);
    publishToolWatch("pub-5", { partialResult: "a" });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    publishToolWatch("pub-5", { partialResult: "ab" });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("getToolWatch", () => {
  it("is undefined for an unknown call", () => {
    expect(getToolWatch("missing")).toBeUndefined();
  });
});

describe("publishBashWatch", () => {
  it("ignores tools that have no mirror", () => {
    publishBashWatch("read", "bash-policy-1", { partialResult: "file contents" });
    expect(getToolWatch("bash-policy-1")).toBeUndefined();
  });

  it("publishes bash snapshots", () => {
    publishBashWatch("bash", "bash-policy-2", { status: "running", partialResult: "tail" });
    expect(getToolWatch("bash-policy-2")).toEqual({ status: "running", partialResult: "tail" });
  });
});

describe("clearToolWatch", () => {
  it("drops the entry so the next seed decides the content again", () => {
    publishToolWatch("clear-1", { status: "running", partialResult: "tail" });
    clearToolWatch("clear-1");
    expect(getToolWatch("clear-1")).toBeUndefined();
  });

  it("does not notify when there was nothing to drop", () => {
    const seen = vi.fn();
    const off = subscribeToolWatch(seen);
    clearToolWatch("clear-absent");
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});