import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getKaloHome } from "../src/utils/kalo-home.ts";

describe("Kalo data root", () => {
	it("uses a full explicit root and keeps the default platform home fallback", () => {
		const home = join(tmpdir(), "user");
		const custom = join(tmpdir(), "中文 data", ".kalo");
		expect(getKaloHome(".kalo", { KALO_HOME: custom, USERPROFILE: home })).toBe(custom);
		expect(getKaloHome(".kalo", { KALO_HOME: "", USERPROFILE: home })).toBe(join(home, ".kalo"));
		expect(getKaloHome(".kalo", { HOME: home })).toBe(join(home, ".kalo"));
		expect(() => getKaloHome(".kalo", { KALO_HOME: "relative", HOME: home })).toThrow("absolute");
		if (process.platform === "win32") {
			expect(() => getKaloHome(".kalo", { KALO_HOME: "\\relative", HOME: home })).toThrow("absolute");
		}
	});
});
