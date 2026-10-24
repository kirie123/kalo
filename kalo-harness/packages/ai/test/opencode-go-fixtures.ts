import type { Model } from "../src/types.ts";

// Historical protocol fixture: compatibility remains testable after catalog delisting.
export const legacyOpenCodeGoKimi: Model<"openai-completions"> = {
	id: "kimi-k2.6",
	name: "Kimi K2.6",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	thinkingLevelMap: { minimal: null, low: null, medium: null },
	input: ["text", "image"],
	cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 65536,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		thinkingFormat: "deepseek",
		supportsLongCacheRetention: false,
	},
};
