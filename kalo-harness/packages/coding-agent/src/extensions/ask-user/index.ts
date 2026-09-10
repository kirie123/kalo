/**
 * ask-user extension — gives the model a structured way to pause and ask.
 *
 * Without it the model's only options are to guess, or to write a question as
 * assistant text and stop — which loses the option metadata a UI needs, and
 * makes the user's reply an unrelated new prompt instead of the result of that
 * decision. `ask_user` is an ordinary tool call that blocks until the human
 * answers, so the answer comes back as a tool result inside the same turn.
 *
 * All judgement lives in the pure modules next to this file (validate/prompt/
 * errors); this file only wires them to the extension API and to the
 * surface-provided `ctx.ui.askUser` channel.
 *
 * Two situations have nobody to answer, and both must make the tool ABSENT
 * rather than let a call hang:
 *   - subagents: children are created with `noExtensions: true` and only the
 *     webfetch factory injected, so this extension never loads there (and
 *     their noOp UI context has no `askUser` either);
 *   - unattended runs (scheduled tasks, IM channel): the desktop app spawns
 *     those engines with KALO_UNATTENDED=1 and the tool is not registered.
 * Registration is decided here at load time because the tool list feeds the
 * system-prompt prefix, so it must be settled before the first request.
 *
 * Design: doc/2026-09-07-ask-user-向用户提问工具.md
 */

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
	AskUserAnswerItem,
	AskUserQuestion,
	ExtensionAPI,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { AskUserError } from "./errors.ts";
import { MAX_HEADER_CHARS, normalizeAskArguments } from "./normalize.ts";
import { askFailureText } from "./prompt.ts";
import { MAX_OPTIONS, MAX_QUESTIONS, validateQuestions } from "./validate.ts";

/** Env flag set by the desktop app for engines nobody is watching. */
const UNATTENDED_ENV = "KALO_UNATTENDED";

/**
 * What lands in the session jsonl and reaches the desktop client: the questions
 * AND the answers, so the transcript can render what was asked, not just what
 * was picked. History replay reads the same field, so a resumed session shows
 * the exchange too.
 */
interface AskUserDetails {
	questions: AskUserQuestion[];
	answers: AskUserAnswerItem[];
}

const AskUserParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "本问的稳定 id，答案里会原样回传。" }),
			// The one and only free-text slot. An earlier version also had a
			// `detail` field, and models routinely wrote the whole question into
			// `header` + `detail` and then omitted this required field, failing the
			// entire batch. Supporting text now belongs in the option descriptions.
			question: Type.String({
				description: "完整的问题正文，必填，以问号结尾。补充说明写进选项的 description，不要另起字段。",
			}),
			header: Type.Optional(
				Type.String({
					description:
						`分类标签，最多 ${MAX_HEADER_CHARS} 字，如「鉴权」「代码风格」。` +
						"它只是个标签，不能代替 question。",
				}),
			),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "简短选项文本；这也是回传给你的值。" }),
						description: Type.Optional(Type.String({ description: "一句话说明这个选项的代价或影响。" })),
					}),
					{
						description:
							`给用户选的选项，最多 ${MAX_OPTIONS} 个。推荐某项就放第一个并在 label 里写「（推荐）」。` +
							"不给选项时用户只能填自由文本。",
					},
				),
			),
			multi_select: Type.Optional(Type.Boolean({ description: "是否允许多选，默认单选。" })),
		}),
		{ description: `本次要问的问题，1~${MAX_QUESTIONS} 个。` },
	),
});

type RawQuestion = {
	id: string;
	question: string;
	header?: string;
	options?: { label: string; description?: string }[];
	multi_select?: boolean;
};

/** Snake_case model input to the camelCase seam vocabulary. */
function toQuestions(raw: RawQuestion[]): AskUserQuestion[] {
	return raw.map((item) => ({
		id: item.id.trim(),
		question: item.question,
		...(item.header !== undefined ? { header: item.header } : {}),
		...(item.options !== undefined
			? {
					options: item.options.map((option) => ({
						label: option.label.trim(),
						...(option.description !== undefined ? { description: option.description } : {}),
					})),
				}
			: {}),
		...(item.multi_select !== undefined ? { multiSelect: item.multi_select } : {}),
	}));
}

/** One answer rendered for a human: the labels, or the free text, or "skipped". */
function describeAnswer(answer: AskUserAnswerItem): string {
	const parts: string[] = [];
	if (answer.selected.length > 0) parts.push(answer.selected.join("、"));
	if (answer.custom !== undefined) parts.push(answer.custom);
	return parts.length > 0 ? parts.join(" / ") : "（跳过）";
}

export default function askUserExtension(pi: ExtensionAPI): void {
	if (process.env[UNATTENDED_ENV] === "1") return;

	pi.registerTool({
		name: "ask_user",
		label: "提问",
		description:
			"Ask the user for a decision, confirmation, or missing information, and wait for the answer. " +
			"Use it when the right next step depends on something only the user knows — which of two designs " +
			"to follow, whether a destructive change is intended, which of several candidates they meant. " +
			"Do NOT use it for anything you can determine yourself by reading files or running commands. " +
			`Send all related questions in ONE call (max ${MAX_QUESTIONS}); each needs a stable id that is ` +
			"echoed in the answer. Prefer offering options with a one-sentence description of each tradeoff; " +
			"omit options only when the answer is genuinely free-form. Every question needs its own full " +
			"`question` text ending in a question mark; `header` is a short category tag and never a " +
			"substitute for it. The answer comes back as this tool's result: selected option labels per " +
			"question, plus free text when the user typed their own.",
		promptSnippet: "ask_user(questions) — 需要用户确认/选择/补充信息时提问，答案作为工具结果返回",
		promptGuidelines: [
			"自己能查清的事不要问用户：先读文件、跑命令确认，只有取决于用户意图的岔路才用 ask_user",
			`ask_user 一次问完相关的几个问题（最多 ${MAX_QUESTIONS} 个），尽量给选项并为每个选项写一句代价说明`,
			"用户关掉提问（ASK_CANCELLED）后不要重新提问，停下来等他说话",
		],
		parameters: AskUserParams,
		// Runs before schema validation: promotes an overloaded `header` into the
		// missing `question` instead of failing a whole batch over one field.
		prepareArguments: normalizeAskArguments as (args: unknown) => never,
		// Serial so two questions never contend for the same input area: the
		// second call starts only after the first is answered, which is why a
		// surface only ever has one pending request.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const questions = toQuestions(params.questions as RawQuestion[]);
			const invalid = validateQuestions(questions);
			if (invalid !== undefined) throw new Error(`ask_user：${invalid}`);

			const ask = ctx.ui.askUser;
			if (ask === undefined) throw new Error(askFailureText("NO_ASK_CHANNEL"));

			let answers: AskUserAnswerItem[];
			try {
				const result = await ask({ questions, ...(signal !== undefined ? { signal } : {}) });
				answers = result.answers;
			} catch (err) {
				if (err instanceof AskUserError) throw new Error(askFailureText(err.code, err.message));
				throw err;
			}

			return {
				// JSON rather than prose: the model reads its own answer back
				// without having to parse a sentence.
				content: [{ type: "text", text: JSON.stringify({ answers }) }],
				details: { questions, answers } satisfies AskUserDetails,
			};
		},

		renderCall(args, theme, _context) {
			const count = args.questions.length;
			const first = args.questions[0]?.question ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", count > 1 ? `${count} 个问题` : first),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			const { questions, answers } = details;
			if (!expanded) {
				const summary = answers.map(describeAnswer).join("；");
				return new Text(theme.fg("muted", summary), 0, 0);
			}
			let text = "";
			for (const [index, question] of questions.entries()) {
				const answer = answers[index];
				if (index > 0) text += "\n";
				text += `${theme.fg("dim", question.question)}\n${theme.fg("accent", "→ ")}${theme.fg("muted", answer === undefined ? "（无答案）" : describeAnswer(answer))}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
