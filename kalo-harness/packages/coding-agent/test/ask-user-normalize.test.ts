import { describe, expect, it } from "vitest";
import { normalizeAskArguments } from "../src/extensions/ask-user/normalize.ts";

/** Read back the normalized question list, typed for assertions. */
function questionsOf(args: unknown): Record<string, unknown>[] {
	return (args as { questions: Record<string, unknown>[] }).questions;
}

const OPTIONS = [{ label: "改 A" }, { label: "改 B" }];

describe("normalizeAskArguments", () => {
	it("leaves a well-formed batch alone", () => {
		const args = { questions: [{ id: "q1", question: "改哪个？", header: "代码风格", options: OPTIONS }] };

		expect(questionsOf(normalizeAskArguments(args))).toEqual([
			{ id: "q1", question: "改哪个？", header: "代码风格", options: OPTIONS },
		]);
	});

	it("promotes an overloaded header into a missing question", () => {
		// The real failure: the model wrote the question as header + detail and
		// omitted `question`, which used to reject all four questions at once.
		const args = {
			questions: [
				{
					id: "backend",
					header: "后端跑不起来",
					detail: "本机只有 Python 3.10.0a5，今晚无法自测。",
					options: OPTIONS,
				},
			],
		};

		expect(questionsOf(normalizeAskArguments(args))).toEqual([
			{
				id: "backend",
				question: "后端跑不起来\n本机只有 Python 3.10.0a5，今晚无法自测。",
				options: OPTIONS,
			},
		]);
	});

	it("drops the header it promoted so the text is not shown twice", () => {
		const args = { questions: [{ id: "q1", header: "用哪个方案？", options: OPTIONS }] };

		const [question] = questionsOf(normalizeAskArguments(args));
		expect(question.question).toBe("用哪个方案？");
		expect(question).not.toHaveProperty("header");
	});

	it("keeps a short header when the question is already there", () => {
		const args = { questions: [{ id: "q1", question: "改哪个？", header: "鉴权", detail: "两处调用点。" }] };

		expect(questionsOf(normalizeAskArguments(args))).toEqual([
			{ id: "q1", question: "改哪个？\n两处调用点。", header: "鉴权" },
		]);
	});

	it("uses detail alone when there is no header either", () => {
		const args = { questions: [{ id: "q1", detail: "要不要顺带迁移旧表？" }] };

		expect(questionsOf(normalizeAskArguments(args))).toEqual([{ id: "q1", question: "要不要顺带迁移旧表？" }]);
	});

	it("synthesizes ids by position so a missing id does not fail the batch", () => {
		const args = { questions: [{ question: "第一问？" }, { id: "  ", question: "第二问？" }] };

		expect(questionsOf(normalizeAskArguments(args)).map((q) => q.id)).toEqual(["q1", "q2"]);
	});

	it("leaves a question with no text at all for validation to reject", () => {
		const args = { questions: [{ id: "q1", options: OPTIONS }] };

		const [question] = questionsOf(normalizeAskArguments(args));
		expect(question).not.toHaveProperty("question");
	});

	it("treats blank strings as absent rather than as content", () => {
		const args = { questions: [{ id: "q1", question: "   ", header: "选方案", options: OPTIONS }] };

		expect(questionsOf(normalizeAskArguments(args))[0].question).toBe("选方案");
	});

	it("passes through input that is not a question batch", () => {
		expect(normalizeAskArguments(null)).toBe(null);
		expect(normalizeAskArguments("garbage")).toBe("garbage");
		expect(normalizeAskArguments({ questions: "nope" })).toEqual({ questions: "nope" });
	});
});
