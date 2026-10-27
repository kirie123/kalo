import { describe, expect, it } from "vitest";
import {
  activateTab,
  addTab,
  closeTab,
  initialPanelState,
  nextTabId,
  setTabUrl,
  shortCommandLabel,
  showFilePanel,
  togglePanel,
  type PanelState,
  type PanelTab,
} from "./panel-tabs";

const shell = (id: string): PanelTab => ({ id, kind: "shell", cwd: null });
const browser = (id: string, url: string): PanelTab => ({ id, kind: "browser", url });
const watch = (id: string, toolCallId: string, command = "npm test"): PanelTab => ({
  id,
  kind: "watch",
  toolCallId,
  command,
});

const state = (partial: Partial<PanelState>): PanelState => ({ ...initialPanelState, ...partial });

describe("togglePanel", () => {
  it("closes an open panel and reopens a closed one", () => {
    const closed = togglePanel(state({ open: true }));
    expect(closed.open).toBe(false);
    expect(togglePanel(closed).open).toBe(true);
  });

  it("leaves tabs and the active tab alone", () => {
    const next = togglePanel(state({ open: true, tabs: [shell("t-1")], activeId: "t-1" }));
    expect(next.tabs).toHaveLength(1);
    expect(next.activeId).toBe("t-1");
  });
});

describe("activateTab", () => {
  it("focuses a known tab", () => {
    const next = activateTab(state({ tabs: [shell("t-1")], activeId: "" }), "t-1");
    expect(next.activeId).toBe("t-1");
  });

  it("ignores an unknown id", () => {
    const base = state({ tabs: [shell("t-1")], activeId: "t-1" });
    expect(activateTab(base, "nope")).toBe(base);
  });

  it("clears the focus with an empty id, handing the screen to the file side", () => {
    const next = activateTab(state({ tabs: [shell("t-1")], activeId: "t-1" }), "");
    expect(next.activeId).toBe("");
    expect(next.tabs).toHaveLength(1);
  });
});

describe("showFilePanel", () => {
  it.each(["b-1", "t-1"])("reveals files from a hidden panel focused on %s without losing its tabs", (activeId) => {
    const base = state({ open: false, tabs: [browser("b-1", "https://example.com"), shell("t-1")], activeId });
    const shown = showFilePanel(base);
    expect(shown.open).toBe(true);
    expect(shown.activeId).toBe("");
    expect(shown.tabs).toEqual(base.tabs);
    expect(base.open).toBe(false);
    expect(base.activeId).toBe(activeId);
  });

  it("keeps the file area open when another deliverable is selected", () => {
    const shown = showFilePanel(state({}));
    expect(showFilePanel(shown)).toEqual(shown);
  });
});

describe("addTab", () => {
  it("opens the panel and focuses the new tab", () => {
    const next = addTab(state({ open: false }), shell("t-1"));
    expect(next.open).toBe(true);
    expect(next.tabs.map((t) => t.id)).toEqual(["t-1"]);
    expect(next.activeId).toBe("t-1");
  });

  it("focuses the existing mirror instead of stacking a second one", () => {
    const base = state({ tabs: [watch("w-1", "call-1"), shell("t-1")], activeId: "t-1" });
    const next = addTab(base, watch("w-1", "call-1"));
    expect(next.tabs).toHaveLength(2);
    expect(next.activeId).toBe("w-1");
  });

  it("keeps two different calls of the same command as separate tabs", () => {
    const next = addTab(state({ tabs: [watch("w-1", "call-1")], activeId: "w-1" }), watch("w-2", "call-2"));
    expect(next.tabs.map((t) => t.id)).toEqual(["w-1", "w-2"]);
  });

  it("focuses an existing browser tab with the same URL", () => {
    const base = state({ tabs: [browser("b-1", "http://localhost:3000")], activeId: "" });
    const next = addTab(base, browser("b-2", "http://localhost:3000"));
    expect(next.tabs).toHaveLength(1);
    expect(next.activeId).toBe("b-1");
  });

  it("keeps browser tabs with different URLs apart", () => {
    const next = addTab(state({ tabs: [browser("b-1", "http://a.com")] }), browser("b-2", "http://b.com"));
    expect(next.tabs.map((t) => t.id)).toEqual(["b-1", "b-2"]);
  });

  it("always adds another shell", () => {
    const next = addTab(state({ tabs: [shell("t-1")], activeId: "t-1" }), shell("t-2"));
    expect(next.tabs.map((t) => t.id)).toEqual(["t-1", "t-2"]);
  });
});

describe("closeTab", () => {
  it("falls back to the neighbour on the left when the active tab closes", () => {
    const base = state({ tabs: [shell("t-1"), shell("t-2")], activeId: "t-2" });
    const next = closeTab(base, "t-2");
    expect(next.tabs.map((t) => t.id)).toEqual(["t-1"]);
    expect(next.activeId).toBe("t-1");
  });

  it("falls back to the tab that took the closed first tab's place", () => {
    const base = state({ tabs: [shell("t-1"), shell("t-2")], activeId: "t-1" });
    const next = closeTab(base, "t-1");
    expect(next.tabs.map((t) => t.id)).toEqual(["t-2"]);
    expect(next.activeId).toBe("t-2");
  });

  it("clears the focus when the last tab closes, so the file side shows", () => {
    const next = closeTab(state({ tabs: [shell("t-1")], activeId: "t-1" }), "t-1");
    expect(next.tabs).toEqual([]);
    expect(next.activeId).toBe("");
  });

  it("keeps the active tab when another one closes", () => {
    const base = state({ tabs: [shell("t-1"), shell("t-2")], activeId: "t-1" });
    const next = closeTab(base, "t-2");
    expect(next.activeId).toBe("t-1");
  });

  it("ignores an unknown id", () => {
    const base = state({ tabs: [shell("t-1")], activeId: "t-1" });
    expect(closeTab(base, "nope")).toBe(base);
  });
});

describe("setTabUrl", () => {
  it("updates the addressed tab", () => {
    const base = state({ tabs: [browser("b-1", ""), browser("b-2", "http://a.com")] });
    const next = setTabUrl(base, "b-1", "http://localhost:3000");
    expect(next.tabs[0]).toEqual({ id: "b-1", kind: "browser", url: "http://localhost:3000" });
    expect(next.tabs[1]).toEqual({ id: "b-2", kind: "browser", url: "http://a.com" });
  });

  it("does not touch non-browser tabs", () => {
    const base = state({ tabs: [shell("t-1")], activeId: "t-1" });
    const next = setTabUrl(base, "t-1", "http://x");
    expect(next.tabs[0]).toEqual(shell("t-1"));
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
  it("starts closed so the directory panel does not occupy chat space", () => {
    expect(initialPanelState).toEqual({ open: false, tabs: [], activeId: "" });
  });
});
