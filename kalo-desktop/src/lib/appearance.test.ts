import { describe, expect, it } from "vitest";
import { appearanceIsDark, parseSkin, parseTheme } from "./appearance";

describe("appearance preferences", () => {
  it("retains legacy light/dark preferences and recovers unknown stored values", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("broken")).toBe("system");
    expect(parseSkin(null)).toBe("clear");
    expect(parseSkin("mist")).toBe("clear");
  });

  it("lets paper follow the OS while explicit light wins over a dark OS", () => {
    expect(appearanceIsDark("system", "paper", true)).toBe(true);
    expect(appearanceIsDark("system", "paper", false)).toBe(false);
    expect(appearanceIsDark("light", "paper", true)).toBe(false);
  });

  it("keeps night dark and restores the retained preference on leaving it", () => {
    expect(appearanceIsDark("light", "night", false)).toBe(true);
    expect(appearanceIsDark("light", "clear", false)).toBe(false);
    expect(appearanceIsDark("dark", "paper", false)).toBe(true);
  });
});
