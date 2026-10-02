import { describe, expect, it } from "vitest";
import {
  addTab,
  activateTab,
  closeTab,
  FILES_TAB_ID,
  initialPanelState,
  nextTabId,
  setTabUrl,
  shortCommandLabel,
  togglePanel,
  type PanelState,
  type PanelTab,
} from "./panel-tabs";

const files: PanelTab = { id: FILES_TAB_ID, kind: "files" };
const shell = (id: string): PanelTab => ({ id, kind: "shell", cwd: null });
const browser = (id: string, url: string): PanelTab => ({ id, kind: "browser", url });
const watch = (id: string, toolCallId: string, command = "npm test"): PanelTab => ({
  id,
  kind: "watch",
  toolCallId,
  command,
});

const state = (partial: Partial<PanelState>): PanelState => ({
  ...initialPanelState,
  tabs: [files],
  ...partial,
});

describe("togglePanel", () => {
  it("closes an open panel and reopens a closed one", () => {
    const closed = togglePanel(state({ open: true }));
    expect(closed.open).toBe(false);
    expect(togglePanel(closed).open).toBe(true);
  });

  it("leaves tabs and the active tab alone", () => {
    const next = togglePanel(state({ open: true, tabs: [files, shell("t-1")], activeId: "t-1" }));
    expect(next.tabs).toHaveLength(2);
    expect(next.activeId).toBe("t-1");
  });
});

describe("activateTab", () => {
  it("focuses a known tab", () => {
    const next = activateTab(state({ tabs: [files, shell("t-1")], activeId: FILES_TAB_ID }), "t-1");
    expect(next.activeId).toBe("t-1");
  });

  it("ignores an unknown id", () => {
    const base = state({ tabs: [files, shell("t-1")], activeId: "t-1" });
    expect(activateTab(base, "nope")).toBe(base);
  });
});

describe("addTab", () => {
  it("opens the panel and focuses the new tab", () => {
    const next = addTab(state({ open: false }), shell("t-1"));
    expect(next.open).toBe(true);
    expect(next.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID, "t-1"]);
    expect(next.activeId).toBe("t-1");
  });

  it("never stacks a second file tab", () => {
    const base = state({ tabs: [files, shell("t-1")], activeId: "t-1" });
    const next = addTab(base, { id: FILES_TAB_ID, kind: "files" });
    expect(next.tabs.filter((t) => t.kind === "files")).toHaveLength(1);
    expect(next.activeId).toBe(FILES_TAB_ID);
  });

  it("focuses the existing mirror instead of stacking a second one", () => {
    const base = state({ tabs: [files, watch("w-1", "call-1"), shell("t-1")], activeId: "t-1" });
    const next = addTab(base, watch("w-1", "call-1"));
    expect(next.tabs).toHaveLength(3);
    expect(next.activeId).toBe("w-1");
  });

  it("keeps two different calls of the same command as separate tabs", () => {
    const next = addTab(state({ tabs: [files, watch("w-1", "call-1")], activeId: "w-1" }), watch("w-2", "call-2"));
    expect(next.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID, "w-1", "w-2"]);
  });

  it("focuses an existing browser tab with the same URL", () => {
    const base = state({ tabs: [files, browser("b-1", "http://localhost:3000")], activeId: FILES_TAB_ID });
    const next = addTab(base, browser("b-2", "http://localhost:3000"));
    expect(next.tabs).toHaveLength(2);
    expect(next.activeId).toBe("b-1");
  });

  it("keeps browser tabs with different URLs apart", () => {
    const next = addTab(state({ tabs: [files, browser("b-1", "http://a.com")] }), browser("b-2", "http://b.com"));
    expect(next.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID, "b-1", "b-2"]);
  });

  it("always adds another shell", () => {
    const next = addTab(state({ tabs: [files, shell("t-1")], activeId: "t-1" }), shell("t-2"));
    expect(next.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID, "t-1", "t-2"]);
  });
});

describe("closeTab", () => {
  it("never closes the file tab", () => {
    const base = state({ tabs: [files, shell("t-1")], activeId: "t-1" });
    expect(closeTab(base, FILES_TAB_ID)).toBe(base);
  });

  it("falls back to the neighbour on the left when the active tab closes", () => {
    const base = state({ tabs: [files, shell("t-1"), shell("t-2")], activeId: "t-2" });
    const next = closeTab(base, "t-2");
    expect(next.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID, "t-1"]);
    expect(next.activeId).toBe("t-1");
  });

  it("falls back to the file tab when the first extra tab closes", () => {
    const base = state({ tabs: [files, shell("t-1")], activeId: "t-1" });
    const next = closeTab(base, "t-1");
    expect(next.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID]);
    expect(next.activeId).toBe(FILES_TAB_ID);
  });

  it("keeps the active tab when another one closes", () => {
    const base = state({ tabs: [files, shell("t-1"), shell("t-2")], activeId: "t-1" });
    const next = closeTab(base, "t-2");
    expect(next.activeId).toBe("t-1");
  });

  it("ignores an unknown id", () => {
    const base = state({ tabs: [files, shell("t-1")], activeId: "t-1" });
    expect(closeTab(base, "nope")).toBe(base);
  });
});

describe("setTabUrl", () => {
  it("updates the addressed tab", () => {
    const base = state({ tabs: [files, browser("b-1", ""), browser("b-2", "http://a.com")] });
    const next = setTabUrl(base, "b-1", "http://localhost:3000");
    expect(next.tabs[1]).toEqual({ id: "b-1", kind: "browser", url: "http://localhost:3000" });
    expect(next.tabs[2]).toEqual({ id: "b-2", kind: "browser", url: "http://a.com" });
  });

  it("does not touch non-browser tabs", () => {
    const base = state({ tabs: [files, shell("t-1")], activeId: "t-1" });
    const next = setTabUrl(base, "t-1", "http://x");
    expect(next.tabs[1]).toEqual(shell("t-1"));
  });
});

describe("shortCommandLabel", () => {
  it("uses the first line of a multi-line command", () => {
    expect(shortCommandLabel("npm run build\nrm -rf /tmp/x")).toBe("npm run build");
  });

  it("trims surrounding whitespace", () => {
    expect(shortCommandLabel("  ls -la  ")).toBe("ls -la");
  });

  it("truncates past the limit with an ellipsis", () => {
    const label = shortCommandLabel("x".repeat(40));
    expect(label).toBe(`${"x".repeat(17)}…`);
    expect(label).toHaveLength(18);
  });

  it("keeps a label exactly at the limit intact", () => {
    expect(shortCommandLabel("y".repeat(18))).toBe("y".repeat(18));
  });

  it("returns an empty string for empty input", () => {
    expect(shortCommandLabel("   ")).toBe("");
  });
});

describe("nextTabId", () => {
  it("does not collide across rapid calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextTabId("t")));
    expect(ids.size).toBe(50);
  });

  it("carries the kind's prefix", () => {
    expect(nextTabId("b")).toMatch(/^b-/);
  });
});

describe("initialPanelState", () => {
  it("starts open on the file tab", () => {
    expect(initialPanelState).toEqual({ open: true, tabs: [{ id: "files", kind: "files" }], activeId: "files" });
  });
});