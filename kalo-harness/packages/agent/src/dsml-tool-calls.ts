/**
 * Detects tool invocations that a model narrated inside its reasoning
 * ("thinking") channel instead of emitting as real tool calls.
 *
 * Some models served through Anthropic-messages compatible gateways write their
 * native tool-call markup into the reasoning channel. Such gateways convert that
 * markup only when it appears in the answer channel, so thinking-channel markup
 * is relayed as plain text: the tool never runs, there is no tool result and no
 * error, and the model continues as if the call had succeeded.
 *
 * The marker shape is an ASCII "<", the fullwidth vertical bar (U+FF5C, some
 * proxies normalize it to "|"), "DSML", another bar, then an `invoke` tag that
 * carries a `name` attribute.
 */
const DSML_INVOKE_SOURCE = '<[\\uff5c|]DSML[\\uff5c|]\\s*invoke\\b[^>]{0,200}?name="([^"\\r\\n]+)"';

/**
 * Returns the tool names referenced by thinking-channel tool-call markup.
 * Answer-channel text is never scanned, so ordinary prose about tools is
 * unaffected. Matches inside fenced code blocks are treated as quotations.
 */
export function findThinkingChannelToolNames(thinking: string): string[] {
	const names = new Set<string>();
	for (const match of thinking.matchAll(new RegExp(DSML_INVOKE_SOURCE, "g"))) {
		if (isInsideCodeFence(thinking, match.index ?? 0)) continue;
		names.add(match[1]);
	}
	return [...names];
}

function isInsideCodeFence(text: string, index: number): boolean {
	let fences = 0;
	let cursor = text.indexOf("```");
	while (cursor !== -1 && cursor < index) {
		fences++;
		cursor = text.indexOf("```", cursor + 3);
	}
	return fences % 2 === 1;
}

/**
 * Returns the subset of thinking-channel tool names that have no executed
 * counterpart in the same assistant message. Names must belong to a registered
 * tool; unknown names are ignored so reasoning that merely mentions a
 * tool-shaped string cannot trigger recovery.
 */
export function findUnexecutedThinkingChannelToolCalls(
	thinkingToolNames: readonly string[],
	executedToolNames: ReadonlySet<string>,
	registeredToolNames: ReadonlySet<string>,
): string[] {
	const missing = new Set<string>();
	for (const name of thinkingToolNames) {
		if (registeredToolNames.has(name) && !executedToolNames.has(name)) {
			missing.add(name);
		}
	}
	return [...missing];
}
