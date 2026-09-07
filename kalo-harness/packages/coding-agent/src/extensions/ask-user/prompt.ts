/**
 * Model-facing text for ask_user failures.
 *
 * Kept separate from the wiring so the exact wording is reviewable and
 * testable. Each message says what happened AND what to do instead, because
 * the model's next step is the only thing these strings can influence.
 */

import type { AskUserErrorCode } from "./errors.ts";

const GUIDANCE: Record<AskUserErrorCode, string> = {
	NO_ASK_CHANNEL:
		"当前界面无法向用户提问（无人值守运行或没有可收集答案的界面）。" +
		"不要重试：自己作出最合理的选择并在答复里说明取舍，或把待决问题写进最终答复交给用户。",
	ASK_CANCELLED: "用户关掉了提问，选择直接说话。不要重新提问，也不要改写问题再试一次——停在这里，等用户的下一条消息。",
	ASK_ABORTED: "提问在用户回答前被中止（本轮已停止）。不要重试。",
	BAD_ANSWER: "提问通道返回了与问题不匹配的答案，这一次提问没有结果。可以换个更简单的问法重试一次。",
};

/** The tool error text for one failure code. */
export function askFailureText(code: AskUserErrorCode, detail?: string): string {
	const suffix = detail === undefined ? "" : `（${detail}）`;
	return `ask_user [${code}]${suffix}：${GUIDANCE[code]}`;
}
