/**
 * Repair a model-supplied ask_user batch before schema validation sees it.
 *
 * The failure this exists for: a model writes `header: "后端跑不起来"` plus a
 * paragraph of context, considers the question fully expressed, and omits the
 * required `question` field entirely. Schema validation then rejects the whole
 * call — four questions lost — and the error plus the echoed arguments cost a
 * round trip before the model resends the same batch with one field added.
 *
 * The structural fix is in the schema next door (one question slot, one short
 * tag slot, no third free-text slot). This module is the belt to that
 * suspenders: when a model still overloads the tag, promote it into the
 * question rather than fail. Same shape as the grep tool accepting `query` for
 * `pattern`.
 *
 * Only ever promotes text the model already wrote, and never invents an answer
 * or an option — a batch with nothing question-shaped in it falls through
 * unchanged so validation reports the real problem.
 */

/** Longest a header may be before it stops reading as a category tag. */
export const MAX_HEADER_CHARS = 12;

/** Trimmed string content, or undefined when the value is absent or blank. */
function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Normalize one question object.
 *
 * @param raw The question as the model wrote it.
 * @param index Position in the batch, used to synthesize a missing id.
 * @returns A question object with `question` populated when anything in the
 *   input can supply it, and the retired `detail` field folded into it.
 */
function normalizeQuestion(raw: unknown, index: number): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const source = raw as Record<string, unknown>;

	const question = text(source.question);
	const header = text(source.header);
	// `detail` is no longer part of the tool contract, but models that learned
	// the older shape still send it; its text is kept rather than dropped.
	const detail = text(source.detail);

	const next: Record<string, unknown> = { ...source };
	delete next.detail;

	// Answers route by id positionally, so a synthesized id is as good as a
	// model-written one and beats failing the batch over a missing string.
	if (text(source.id) === undefined) next.id = `q${index + 1}`;

	if (question !== undefined) {
		if (detail !== undefined) next.question = `${question}\n${detail}`;
		return next;
	}

	const promoted = header ?? detail;
	// Nothing question-shaped to promote: leave it alone so validation says so.
	if (promoted === undefined) return next;

	next.question = header !== undefined && detail !== undefined ? `${header}\n${detail}` : promoted;
	// The header became the question; leaving it would render the same words
	// twice, once as a tag and once as the question.
	if (header !== undefined) delete next.header;
	return next;
}

/**
 * Normalize a raw `ask_user` argument object.
 *
 * @param args Arguments exactly as the model produced them.
 * @returns The arguments with each question normalized; non-object input and
 *   a missing or non-array `questions` pass through for validation to reject.
 */
export function normalizeAskArguments(args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const source = args as Record<string, unknown>;
	if (!Array.isArray(source.questions)) return args;
	return { ...source, questions: source.questions.map(normalizeQuestion) };
}
