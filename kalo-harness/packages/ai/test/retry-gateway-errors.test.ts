import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

// An Anthropic-messages relay answers with these 400s when a request carries a
// very large cached context; the identical request succeeds when re-sent.
const relayTransient400Message =
	'400 {"error":{"message":"This request is not supported. (request id: 202609200204559728632598268d9d6hMBG3x87)","type":"invalid_request_error"},"type":"error"}';

// Upstream subscription quota exhaustion. Not transient: retrying cannot help.
const upstreamQuota400Message = [
	'400 {"error":{"type":"nil-value","message":"Third-party apps now draw',
	'from your extra usage, not your plan limits. Add more and keep going."},',
	'"type":"error"}',
].join(" ");

describe("Anthropic-messages gateway error classification", () => {
	it("treats the relay's transient 'not supported' 400 as retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: relayTransient400Message }),
			),
		).toBe(true);
	});

	it("still fails fast on upstream subscription quota errors", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: upstreamQuota400Message }),
			),
		).toBe(false);
	});
});
