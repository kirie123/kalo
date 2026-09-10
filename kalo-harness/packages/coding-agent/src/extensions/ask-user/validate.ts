/**
 * Pure validators for the askUser batch, both directions.
 *
 * `validateQuestions` guards what the model sends; `validateAnswers` guards
 * what a client sends back. The answer side lives here, in the engine, rather
 * than in each frontend: a frontend is replaceable, unverified input (today the
 * desktop app, tomorrow another client or a hand-written NDJSON line), so
 * checking once here means every surface gets the same strictness and no
 * surface has to reimplement it.
 *
 * Neither validator repairs anything. Silently fixing an answer turns a client
 * bug into a wrong decision the user never sees.
 */

import type { AskUserAnswerItem, AskUserQuestion } from "../../core/extensions/types.ts";
import { MAX_HEADER_CHARS } from "./normalize.ts";

/** Most questions one batch may carry; more than this is offloading a whole design onto the user. */
export const MAX_QUESTIONS = 5;
/** Most options one question may offer; beyond this it stops being a choice. */
export const MAX_OPTIONS = 6;
/** Longest option label; a longer one means the text belongs in `description`. */
export const MAX_LABEL_CHARS = 40;

/**
 * Validate a model-supplied question batch.
 *
 * @returns Error message for the model, or undefined when the batch is valid.
 */
export function validateQuestions(questions: AskUserQuestion[]): string | undefined {
	if (questions.length === 0) return "ask_user 需要至少 1 个问题。";
	if (questions.length > MAX_QUESTIONS) {
		return `ask_user 一次最多 ${MAX_QUESTIONS} 个问题，收到 ${questions.length} 个。请只问真正需要用户决定的。`;
	}

	const seenIds = new Set<string>();
	for (const question of questions) {
		const id = question.id.trim();
		if (id === "") return "每个问题都需要非空的 id。";
		if (seenIds.has(id)) return `问题 id 重复：${id}。答案按 id 回传，id 必须唯一。`;
		seenIds.add(id);

		if (question.question.trim() === "") return `问题 ${id} 的 question 为空。`;

		// A long header means the model is writing the question there instead of
		// in `question`, which is the shape that used to fail the whole batch.
		const header = question.header;
		if (header !== undefined && header.trim().length > MAX_HEADER_CHARS) {
			return `问题 ${id} 的 header 超过 ${MAX_HEADER_CHARS} 字。header 只是分类标签，把正文写进 question。`;
		}

		const options = question.options;
		if (options === undefined) continue;
		if (options.length > MAX_OPTIONS) {
			return `问题 ${id} 有 ${options.length} 个选项，最多 ${MAX_OPTIONS} 个。`;
		}
		const seenLabels = new Set<string>();
		for (const option of options) {
			const label = option.label.trim();
			if (label === "") return `问题 ${id} 有空的选项 label。`;
			if (label.length > MAX_LABEL_CHARS) {
				return `问题 ${id} 的选项 label 超过 ${MAX_LABEL_CHARS} 字符：${label.slice(0, 20)}…。把说明写进 description。`;
			}
			if (seenLabels.has(label)) return `问题 ${id} 的选项 label 重复：${label}。`;
			seenLabels.add(label);
		}
	}
	return undefined;
}

/**
 * Validate one answer batch against the exact questions it answers.
 *
 * Answers must arrive in question order rather than being matched by id in any
 * order: that way "skipped one question" cannot disguise itself as "answered a
 * different one".
 *
 * @returns Reason the batch is invalid, or undefined when it fits.
 */
export function validateAnswers(questions: AskUserQuestion[], answers: AskUserAnswerItem[]): string | undefined {
	if (answers.length !== questions.length) {
		return `期望 ${questions.length} 条答案，收到 ${answers.length} 条。`;
	}

	for (const [index, question] of questions.entries()) {
		const answer = answers[index];
		if (answer.id !== question.id) {
			return `第 ${index + 1} 条答案的 id 是 ${answer.id}，期望 ${question.id}。`;
		}

		const selected = answer.selected;
		if (new Set(selected).size !== selected.length) {
			return `问题 ${question.id} 的答案里有重复选项。`;
		}

		const labels = new Set((question.options ?? []).map((option) => option.label));
		for (const label of selected) {
			if (!labels.has(label)) {
				return `问题 ${question.id} 的答案里有不属于该问的选项：${label}。`;
			}
		}

		const custom = answer.custom;
		if (custom !== undefined && custom.trim() === "") {
			return `问题 ${question.id} 的自由文本为空；跳过就不要带 custom。`;
		}

		if (question.multiSelect !== true) {
			if (selected.length > 1) {
				return `问题 ${question.id} 是单选，收到 ${selected.length} 个选项。`;
			}
			if (custom !== undefined && selected.length > 0) {
				return `问题 ${question.id} 是单选，选项与自由文本不能同时给出。`;
			}
		}
	}
	return undefined;
}
