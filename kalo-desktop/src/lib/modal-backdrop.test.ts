import { describe, expect, it } from "vitest";
import { isBackdropPress } from "./modal-backdrop";

const backdrop = { tag: "overlay" };
const child = { tag: "input" };

describe("isBackdropPress", () => {
  it("主键按在遮罩本身上算", () => {
    expect(isBackdropPress({ button: 0, target: backdrop, currentTarget: backdrop })).toBe(true);
  });

  it("按在弹窗里的控件上不算", () => {
    expect(isBackdropPress({ button: 0, target: child, currentTarget: backdrop })).toBe(false);
  });

  it("右键与中键不算", () => {
    expect(isBackdropPress({ button: 2, target: backdrop, currentTarget: backdrop })).toBe(false);
    expect(isBackdropPress({ button: 1, target: backdrop, currentTarget: backdrop })).toBe(false);
  });
});