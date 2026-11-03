import { describe, expect, it } from "vitest";
import { selectLayout } from "./select-layout";

describe("research menu placement", () => {
  it("opens below with enough room and preserves shadow clearance", () => {
    const p = selectLayout({ left: 300, top: 100, bottom: 136, width: 240 }, { width: 1280, height: 800 });
    expect(p.top).toBe(142); expect(p.width).toBe(300); expect(p.maxHeight).toBe(320); expect(p.bottom).toBeUndefined();
  });
  it("flips above at the lower right and clamps width to a narrow viewport", () => {
    const p = selectLayout({ left: 400, top: 440, bottom: 476, width: 600 }, { width: 480, height: 500 });
    expect(p.top).toBeUndefined(); expect(p.bottom).toBe(66); expect(p.left).toBe(20); expect(p.width).toBe(440);
    expect(500 - p.bottom! - p.maxHeight).toBeGreaterThanOrEqual(20);
  });
  it("limits scroll height when neither side can fit a full menu", () => {
    const p = selectLayout({ left: 10, top: 150, bottom: 186, width: 200 }, { width: 400, height: 300 });
    expect(p.maxHeight).toBe(124); expect(p.left).toBe(20);
  });
});
