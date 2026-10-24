import { beforeEach, describe, expect, it, vi } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const adapters = vi.hoisted(() => ({
	"anthropic-messages": { stream: vi.fn(), streamSimple: vi.fn() },
	"google-generative-ai": { stream: vi.fn(), streamSimple: vi.fn() },
	"openai-completions": { stream: vi.fn(), streamSimple: vi.fn() },
	"openai-responses": { stream: vi.fn(), streamSimple: vi.fn() },
}));

vi.mock("../src/api/anthropic-messages.lazy.ts", () => ({
	anthropicMessagesApi: () => adapters["anthropic-messages"],
}));
vi.mock("../src/api/google-generative-ai.lazy.ts", () => ({
	googleGenerativeAIApi: () => adapters["google-generative-ai"],
}));
vi.mock("../src/api/openai-completions.lazy.ts", () => ({
	openAICompletionsApi: () => adapters["openai-completions"],
}));
vi.mock("../src/api/openai-responses.lazy.ts", () => ({
	openAIResponsesApi: () => adapters["openai-responses"],
}));

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const apis = Object.keys(adapters) as (keyof typeof adapters)[];

function model(api: keyof typeof adapters): Model<keyof typeof adapters> {
	return {
		id: `routing-${api}`,
		name: "Routing fixture",
		provider: "opencode-go",
		api,
		baseUrl: "https://example.test/zen/go/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

describe("OpenCode Go protocol routing", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each(apis)("dispatches %s through its adapter without changing model or options", (api) => {
		const provider = opencodeGoProvider();
		const requestModel = model(api);
		const options = { apiKey: "fake-opencode-key" };
		const stream = new AssistantMessageEventStream();
		adapters[api].stream.mockReturnValue(stream);
		adapters[api].streamSimple.mockReturnValue(stream);

		expect(provider.stream(requestModel, context, options)).toBe(stream);
		expect(provider.streamSimple(requestModel, context, options)).toBe(stream);
		expect(adapters[api].stream).toHaveBeenCalledWith(requestModel, context, options);
		expect(adapters[api].streamSimple).toHaveBeenCalledWith(requestModel, context, options);
		for (const other of apis.filter((candidate) => candidate !== api)) {
			expect(adapters[other].stream).not.toHaveBeenCalled();
			expect(adapters[other].streamSimple).not.toHaveBeenCalled();
		}
	});

	it("routes every API present in the generated catalog", () => {
		const provider = opencodeGoProvider();
		const models = provider.getModels();
		expect(models.length).toBeGreaterThan(0);
		for (const requestModel of models) {
			const adapter = adapters[requestModel.api];
			expect(adapter, `${requestModel.id}: ${requestModel.api}`).toBeDefined();
			const stream = new AssistantMessageEventStream();
			adapter.streamSimple.mockReturnValue(stream);
			expect(provider.streamSimple(requestModel, context, { apiKey: "fake" })).toBe(stream);
		}
	});
});
