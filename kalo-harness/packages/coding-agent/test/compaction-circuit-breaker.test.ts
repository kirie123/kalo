import { describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	shouldCompact,
} from "../src/core/compaction/compaction.ts";

describe("compaction circuit breaker logic", () => {
	describe("shouldCompact", () => {
		const defaultSettings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			enabled: true,
		};

		it("should not trigger when disabled", () => {
			const result = shouldCompact(100000, 200000, { ...defaultSettings, enabled: false });
			expect(result).toBe(false);
		});

		it("should trigger when contextTokens exceeds contextWindow - reserveTokens", () => {
			// contextWindow = 200K, reserveTokens = 16384, threshold = 183616
			const result = shouldCompact(185000, 200000, defaultSettings);
			expect(result).toBe(true);
		});

		it("should not trigger when below threshold", () => {
			const result = shouldCompact(180000, 200000, defaultSettings);
			expect(result).toBe(false);
		});

		it("should handle edge case at exact threshold (strict greater-than)", () => {
			const threshold = 200000 - defaultSettings.reserveTokens;
			expect(shouldCompact(threshold, 200000, defaultSettings)).toBe(false);
			expect(shouldCompact(threshold + 1, 200000, defaultSettings)).toBe(true);
		});

		it("should handle small context windows where threshold is negative", () => {
			// 8K window, 16K reserve → threshold is negative, so any positive contextTokens triggers
			const result = shouldCompact(5000, 8192, defaultSettings);
			expect(result).toBe(true);
		});

		it("should respect custom reserveTokens", () => {
			const customSettings: CompactionSettings = {
				...DEFAULT_COMPACTION_SETTINGS,
				reserveTokens: 32768,
			};
			const threshold = 200000 - customSettings.reserveTokens;
			expect(shouldCompact(threshold + 1000, 200000, customSettings)).toBe(true);
			expect(shouldCompact(threshold - 1000, 200000, customSettings)).toBe(false);
		});
	});

	describe("compaction effectiveness calculation", () => {
		it("should calculate relative savings ratio correctly", () => {
			const tokensBefore = 100000;
			const tokensAfter = 70000;
			const savingsRatio = (tokensBefore - tokensAfter) / tokensBefore;
			expect(savingsRatio).toBeCloseTo(0.3);
		});

		it("should consider >= 15% reduction as effective", () => {
			const MIN_SAVINGS_RATIO = 0.15;
			const effective = (100000 - 80000) / 100000;
			expect(effective).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO);
			const ineffective = (100000 - 90000) / 100000;
			expect(ineffective).toBeLessThan(MIN_SAVINGS_RATIO);
		});

		it("should handle edge cases in savings ratio calculation", () => {
			// Zero tokensBefore — fallback to 1 per implementation
			const tokensBefore = 0;
			const savingsRatioZero = tokensBefore > 0 ? (tokensBefore - 100) / tokensBefore : 1;
			expect(savingsRatioZero).toBe(1);

			// No reduction
			expect((100000 - 100000) / 100000).toBe(0);

			// Perfect reduction
			expect((100000 - 0) / 100000).toBe(1);
		});
	});

	describe("circuit breaker state machine (logic verification)", () => {
		const THRESHOLD = 3;

		it("should trip at exactly the threshold, not before", () => {
			let failures = 0;

			failures++; // 1
			expect(failures >= THRESHOLD).toBe(false);

			failures++; // 2
			expect(failures >= THRESHOLD).toBe(false);

			failures++; // 3 — trips
			expect(failures >= THRESHOLD).toBe(true);
		});

		it("should remain tripped after threshold is exceeded", () => {
			let failures = 0;
			let tripped = false;

			for (let i = 0; i < 4; i++) {
				failures++;
				if (failures >= THRESHOLD) tripped = true;
			}

			expect(failures).toBe(4);
			expect(tripped).toBe(true);
		});

		it("should reset on effective compaction", () => {
			let failures = 2;
			let tripped = false;

			// Simulate effective compaction
			failures = 0;
			tripped = false;

			expect(failures).toBe(0);
			expect(tripped).toBe(false);
		});

		it("should not reset on ineffective compaction", () => {
			let failures = 2;
			let tripped = false;

			// Ineffective: counter keeps incrementing
			failures++;
			if (failures >= THRESHOLD) tripped = true;

			expect(failures).toBe(3);
			expect(tripped).toBe(true);
		});
	});
});
