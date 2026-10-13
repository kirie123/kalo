import { describe, expect, it } from "vitest";
import type { RpcExtensionUIRequest } from "../types";
import { dispatchExtensionUiRequest, type ExtUiSetters } from "./extension-ui-dispatch";
import { backgroundKeepAliveStatus, selectIdleEvictions } from "./runtime-keep-alive";

function status(statusText: string | undefined, statusKey = "kalo-subagent-background"): RpcExtensionUIRequest {
  return { type: "extension_ui_request", id: "status", method: "setStatus", statusKey, statusText };
}

function runtime(lastActive: number, backgroundKeepAlive = false, isStreaming = false, connecting = false) {
  return { lastActive, backgroundKeepAlive, view: { isStreaming, connecting } };
}

// Only exercise the dispatcher's status branch: no DOM, ChatStore or Tauri IPC.
function dispatchStatus(req: RpcExtensionUIRequest, rt: ReturnType<typeof runtime>, parked: boolean) {
  const unexpected = () => { throw new Error("Status must not request UI interaction or show a toast"); };
  const setters: ExtUiSetters = {
    setPendingAsk: unexpected,
    setExtensionQueue: unexpected,
    currentQueue: unexpected,
    setInputDraft: unexpected,
    setBackgroundKeepAlive: (keepAlive) => { rt.backgroundKeepAlive = keepAlive; },
  };
  dispatchExtensionUiRequest(req, setters, parked, unexpected);
}

describe("background keep-alive status", () => {
  it.each(["1 queued", "2 running", "pending delivery", " "])("keeps alive for nonempty text: %j", (text) => {
    expect(backgroundKeepAliveStatus(status(text))).toBe(true);
  });

  it.each(["", undefined])("releases keep-alive for %j", (text) => {
    expect(backgroundKeepAliveStatus(status(text))).toBe(false);
  });

  it("ignores unrelated status keys and UI methods", () => {
    expect(backgroundKeepAliveStatus(status("running", "another-extension"))).toBeUndefined();
    expect(backgroundKeepAliveStatus(status(undefined, "another-extension"))).toBeUndefined();
    expect(backgroundKeepAliveStatus({
      type: "extension_ui_request", id: "notify", method: "notify", message: "running",
    })).toBeUndefined();
  });

  it("updates only the owning runtime through UI dispatch without marking main turns streaming", () => {
    const active = runtime(10);
    const parked = runtime(1);
    dispatchStatus(status("pending result"), parked, true);
    expect(parked.backgroundKeepAlive).toBe(true);
    expect(active.backgroundKeepAlive).toBe(false);
    expect(parked.view.isStreaming).toBe(false);

    dispatchStatus(status(undefined, "another-extension"), parked, true);
    expect(parked.backgroundKeepAlive).toBe(true);
    dispatchStatus(status("running"), active, false);
    dispatchStatus(status(undefined), parked, true);
    expect(parked.backgroundKeepAlive).toBe(false);
    expect(active.backgroundKeepAlive).toBe(true);
    expect(active.view.isStreaming).toBe(false);
  });
});

describe("ordinary parked LRU", () => {
  it("excludes active, streaming, connecting and background-protected runtimes from both candidates and quota", () => {
    const active = runtime(0);
    const streaming = runtime(1, false, true);
    const connecting = runtime(2, false, false, true);
    const protectedIdle = runtime(3, true);
    const older = runtime(4);
    const newer = runtime(5);
    const pool = [active, newer, protectedIdle, streaming, older, connecting];
    const before = [...pool];
    expect(selectIdleEvictions(pool, active, 2)).toEqual([]);
    expect(selectIdleEvictions(pool, active, 1)).toEqual([older]);
    expect(selectIdleEvictions(pool, active, 0)).toEqual([older, newer]);
    expect(pool).toEqual(before);
    expect(protectedIdle.view.isStreaming).toBe(false);
  });

  it("protects more background runtimes than the normal parked capacity", () => {
    const active = runtime(10);
    const pool = [active, ...Array.from({ length: 6 }, (_, i) => runtime(i, true))];
    expect(selectIdleEvictions(pool, active, 4)).toEqual([]);
  });

  it("returns a released runtime to LRU in last-active order, including pending-result transitions", () => {
    const active = runtime(10);
    const oldest = runtime(0);
    const idle = Array.from({ length: 4 }, (_, i) => runtime(i + 1));
    const pool = new Set([active, ...idle, oldest]);
    dispatchStatus(status("running"), oldest, true);
    expect(selectIdleEvictions(pool, active, 4)).toEqual([]);
    dispatchStatus(status("pending delivery"), oldest, true);
    expect(selectIdleEvictions(pool, active, 4)).toEqual([]);
    dispatchStatus(status(""), oldest, true);
    expect(selectIdleEvictions(pool, active, 4)).toEqual([oldest]);
    expect(oldest.view.isStreaming).toBe(false);
  });
});
