import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getKaloHome } from "./kalo-home";

test("KALO_HOME selects the complete data root and rejects relative overrides", () => {
  const home = join(tmpdir(), "test-home");
  const custom = join(tmpdir(), "中文 data", ".kalo");
  expect(getKaloHome({ KALO_HOME: custom, USERPROFILE: home })).toBe(custom);
  expect(getKaloHome({ KALO_HOME: "", USERPROFILE: home })).toBe(join(home, ".kalo"));
  expect(getKaloHome({ HOME: home })).toBe(join(home, ".kalo"));
  expect(() => getKaloHome({ KALO_HOME: "relative", HOME: home })).toThrow("absolute");
  if (process.platform === "win32") {
    expect(() => getKaloHome({ KALO_HOME: "\\relative", HOME: home })).toThrow("absolute");
  }
});
