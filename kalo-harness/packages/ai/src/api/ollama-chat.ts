import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Ollama native `/api/chat` stream.
 *
 * The OpenAI-compatible `/v1/chat/completions` endpoint has no field for the
 * server-side context length: `num_ctx` is an Ollama-native `options` key.
 * Requests through `/v1` silently truncate to the server default, so Ollama
 * models are routed here where `options.num_ctx` pins the context window to
 * the model's configured `contextWindow`.
 */

const MAX_OLLAMA_ERROR_BODY_CHARS = 4000;

export interface OllamaOptions extends StreamOptions {}

type OllamaWireMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string;
	images?: string[];
	tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
};

type OllamaWireTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};

type OllamaStreamChunk = {
	model?: string;
	created_at?: string;
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: Array<{
			id?: string;
			function?: { index?: number; name?: string; arguments?: Record<string, unknown> | string };
		}>;
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
};

export const stream: StreamFunction<"ollama-chat", OllamaOptions> = (
	model: Model<"ollama-chat">,
	context: Context,
	options?: OllamaOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);

		try {
			const transformedMessages = transformMessages(context.messages, model);
			const payload = buildChatPayload(model, context, transformedMessages, options);
			const signal = options?.signal ?? undefined;
			const response = await (options?.fetch ?? globalThis.fetch)(ollamaChatUrl(model.baseUrl), {
				method: "POST",
				headers: buildOllamaHeaders(options?.apiKey, options?.headers),
				body: JSON.stringify(payload),
				signal,
			});

			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			if (!response.ok) {
				const body = await response.text();
				throw new OllamaHttpError(response.status, body, response.statusText);
			}
			if (!response.body) {
				throw new Error("Ollama response has no body");
			}

			eventStream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, eventStream, response.body, signal);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "pending") {
				throw new Error("Ollama stream ended without a done chunk");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			eventStream.push({ type: "done", reason: output.stopReason, message: output });
			eventStream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { partialArgs?: unknown }).partialArgs;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOllamaError(error);
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"ollama-chat", SimpleStreamOptions> = (
	model: Model<"ollama-chat">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const ollamaOptions: OllamaOptions = { ...base };
	if (reasoning === "off") {
		(ollamaOptions as { think?: boolean }).think = false;
	}
	return stream(model, context, ollamaOptions);
};

function createOutput(model: Model<"ollama-chat">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** Builds the native `/api/chat` URL, tolerating OpenAI-style `/v1` base URLs. */
function ollamaChatUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	let path = url.pathname.replace(/\/+$/u, "");
	if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length).replace(/\/+$/u, "");
	url.pathname = `${path}/api/chat`;
	return url;
}

function buildOllamaHeaders(apiKey: string | undefined, overrides?: Record<string, string | null>): Headers {
	const headers = new Headers({ "content-type": "application/json" });
	// Local Ollama ignores auth; send it only when a key is configured so
	// providers fronted by a gateway still work.
	if (apiKey && apiKey.trim().length > 0) headers.set("authorization", `Bearer ${apiKey}`);
	if (overrides) {
		for (const [name, value] of Object.entries(overrides)) {
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
	}
	return headers;
}

function buildChatPayload(
	model: Model<"ollama-chat">,
	context: Context,
	messages: Message[],
	options?: OllamaOptions,
): Record<string, unknown> {
	const supportsImages = model.input.includes("image");
	const payload: Record<string, unknown> = {
		model: model.id,
		stream: true,
		messages: toOllamaMessages(messages, context.systemPrompt, supportsImages),
		options: {
			// Pin the server context window to the model's configured window so
			// requests are not silently truncated to the Ollama default (4096).
			num_ctx: model.contextWindow > 0 ? model.contextWindow : 131072,
			...(options?.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
			...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
		},
	};
	if (context.tools?.length) payload.tools = toOllamaTools(context.tools);
	if ((options as { think?: boolean } | undefined)?.think === false) payload.think = false;
	return payload;
}

function toOllamaTools(tools: Tool[]): OllamaWireTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
		},
	}));
}

function toOllamaMessages(
	messages: Message[],
	systemPrompt: string | undefined,
	supportsImages: boolean,
): OllamaWireMessage[] {
	const result: OllamaWireMessage[] = [];
	if (systemPrompt) result.push({ role: "system", content: sanitizeSurrogates(systemPrompt) });

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				continue;
			}
			const text = msg.content
				.filter((part): part is Extract<(typeof msg.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => sanitizeSurrogates(part.text))
				.join("\n");
			const images = supportsImages
				? msg.content.filter((part) => part.type === "image").map((part) => (part as { data: string }).data)
				: [];
			const message: OllamaWireMessage = { role: "user", content: text };
			if (images.length > 0) message.images = images;
			result.push(message);
			continue;
		}

		if (msg.role === "assistant") {
			const text = msg.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => sanitizeSurrogates(block.text))
				.join("\n");
			const toolCalls = msg.content
				.filter((block): block is ToolCall => block.type === "toolCall")
				.map((block) => ({
					...(block.id ? { id: block.id } : {}),
					function: { name: block.name, arguments: (block.arguments ?? {}) as Record<string, unknown> },
				}));
			const message: OllamaWireMessage = { role: "assistant", content: text };
			if (toolCalls.length > 0) message.tool_calls = toolCalls;
			result.push(message);
			continue;
		}

		result.push(toOllamaToolResult(msg as ToolResultMessage, supportsImages));
	}

	return result;
}

function toOllamaToolResult(msg: ToolResultMessage, supportsImages: boolean): OllamaWireMessage {
	const text = msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => sanitizeSurrogates(part.text))
		.join("\n");
	const hasImages = msg.content.some((part) => part.type === "image");
	const errorPrefix = msg.isError ? "[tool error] " : "";
	const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
	const content =
		`${errorPrefix}${text}${imageSuffix}` || (msg.isError ? "[tool error] (no tool output)" : "(no tool output)");
	const images = supportsImages
		? msg.content.filter((part) => part.type === "image").map((part) => (part as { data: string }).data)
		: [];
	const message: OllamaWireMessage = { role: "tool", content };
	if (images.length > 0) message.images = images;
	return message;
}

class OllamaHttpError extends Error {
	statusCode: number;
	body: string;

	constructor(statusCode: number, body: string, statusText: string) {
		super(statusText || `Request failed with status ${statusCode}`);
		this.name = "OllamaHttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
}

function formatOllamaError(error: unknown): string {
	if (error instanceof Error) {
		const httpError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : undefined;
		const bodyText = typeof httpError.body === "string" ? httpError.body.trim() : undefined;
		if (statusCode !== undefined && bodyText) {
			return `Ollama API error (${statusCode}): ${truncateText(bodyText, MAX_OLLAMA_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Ollama API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return String(error);
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

async function* readOllamaChunks(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
): AsyncGenerator<OllamaStreamChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) throw signal.reason;
			const { done, value } = await reader.read();
			if (signal?.aborted) throw signal.reason;
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

			// Ollama streams newline-delimited JSON objects.
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) yield JSON.parse(line) as OllamaStreamChunk;
				newline = buffer.indexOf("\n");
			}

			if (done) break;
		}

		const remainder = buffer.trim();
		if (remainder) yield JSON.parse(remainder) as OllamaStreamChunk;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

async function consumeChatStream(
	model: Model<"ollama-chat">,
	output: AssistantMessage,
	eventStream: AssistantMessageEventStream,
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
): Promise<void> {
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const toolBlocksByKey = new Map<string, number>();
	let sawToolCall = false;

	const finishCurrentBlock = (block?: typeof currentBlock) => {
		if (!block) return;
		if (block.type === "text") {
			eventStream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: block.text,
				partial: output,
			});
			return;
		}
		if (block.type === "thinking") {
			eventStream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: block.thinking,
				partial: output,
			});
		}
	};

	for await (const chunk of readOllamaChunks(body, signal)) {
		output.responseId ||= chunk.model;

		if (chunk.done) {
			const promptTokens = chunk.prompt_eval_count ?? 0;
			const completionTokens = chunk.eval_count ?? 0;
			output.usage.input = promptTokens;
			output.usage.output = completionTokens;
			output.usage.cacheRead = 0;
			output.usage.cacheWrite = 0;
			output.usage.totalTokens = promptTokens + completionTokens;
			calculateCost(model, output.usage);

			output.rawStopReason = chunk.done_reason ?? "";
			const stop = mapStopReason(chunk.done_reason, sawToolCall);
			output.stopReason = stop.stopReason;
			if (stop.errorMessage) output.errorMessage = stop.errorMessage;
		}

		const message = chunk.message;
		if (!message) continue;

		const thinkingDelta = message.thinking ? sanitizeSurrogates(message.thinking) : "";
		if (thinkingDelta) {
			if (!currentBlock || currentBlock.type !== "thinking") {
				finishCurrentBlock(currentBlock);
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				eventStream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			}
			currentBlock.thinking += thinkingDelta;
			eventStream.push({
				type: "thinking_delta",
				contentIndex: blockIndex(),
				delta: thinkingDelta,
				partial: output,
			});
		}

		const textDelta = message.content ? sanitizeSurrogates(message.content) : "";
		if (textDelta) {
			if (!currentBlock || currentBlock.type !== "text") {
				finishCurrentBlock(currentBlock);
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				eventStream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			}
			currentBlock.text += textDelta;
			eventStream.push({
				type: "text_delta",
				contentIndex: blockIndex(),
				delta: textDelta,
				partial: output,
			});
		}

		for (const [i, toolCall] of (message.tool_calls ?? []).entries()) {
			sawToolCall = true;
			if (currentBlock) {
				finishCurrentBlock(currentBlock);
				currentBlock = null;
			}
			// Observed wire shape (qwen3.5 on Ollama): { id: "call_xxx",
			// function: { index: 0, name, arguments: {...} } }, with
			// done_reason "stop" rather than "tool_calls".
			const callId = toolCall.id && toolCall.id !== "null" ? toolCall.id : undefined;
			const key = callId ?? `index-${toolCall.function?.index ?? i}`;
			let blockIndexInContent = toolBlocksByKey.get(key);
			let block: (ToolCall & { partialArgs?: string }) | undefined =
				blockIndexInContent !== undefined
					? (blocks[blockIndexInContent] as ToolCall & { partialArgs?: string })
					: undefined;
			if (!block || block.type !== "toolCall") {
				block = {
					type: "toolCall",
					id: callId ?? `ollama-${key}-${output.content.length}`,
					name: toolCall.function?.name ?? "",
					arguments: {},
					partialArgs: "",
				};
				output.content.push(block);
				blockIndexInContent = output.content.length - 1;
				toolBlocksByKey.set(key, blockIndexInContent);
				eventStream.push({ type: "toolcall_start", contentIndex: blockIndexInContent, partial: output });
			}

			// Some builds stream tool calls incrementally (string fragments),
			// others deliver them whole per chunk. Handle both.
			if (toolCall.function?.name) {
				block.name = toolCall.function.name.startsWith(block.name)
					? toolCall.function.name
					: block.name + toolCall.function.name;
			}
			const args = toolCall.function?.arguments;
			let argsDelta = "";
			if (typeof args === "string") argsDelta = args;
			else if (args && typeof args === "object" && Object.keys(args).length > 0) argsDelta = JSON.stringify(args);
			if (argsDelta) {
				block.partialArgs = (block.partialArgs || "") + argsDelta;
				eventStream.push({
					type: "toolcall_delta",
					contentIndex: blockIndexInContent!,
					delta: argsDelta,
					partial: output,
				});
			}
		}
	}

	finishCurrentBlock(currentBlock);
	for (const index of toolBlocksByKey.values()) {
		const block = output.content[index];
		if (block.type !== "toolCall") continue;
		const toolBlock = block as ToolCall & { partialArgs?: string };
		if (toolBlock.partialArgs) {
			toolBlock.arguments = parseToolArgs(toolBlock.partialArgs);
		} else {
			toolBlock.arguments = {};
		}
		delete toolBlock.partialArgs;
		eventStream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: toolBlock,
			partial: output,
		});
	}

	// Older Ollama builds omit done_reason entirely.
	if (output.stopReason === "pending" && sawToolCall) {
		output.stopReason = "toolUse";
		output.rawStopReason = "tool_calls";
	}
}

function parseToolArgs(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {}
	return {};
}

function mapStopReason(
	reason: string | undefined,
	sawToolCall: boolean,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case undefined:
		case "":
		case "stop":
			return sawToolCall ? { stopReason: "toolUse" } : { stopReason: "stop" };
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "length":
			return { stopReason: "length" };
		case "load":
			return { stopReason: "error", errorMessage: "Ollama failed to load the model" };
		case "error":
			return { stopReason: "error", errorMessage: "Provider stopped with: error" };
		default:
			return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
	}
}
