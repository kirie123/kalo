import { describe, expect, it } from "vitest";
import type { AskUserAnswerItem, AskUserQuestion } from "../src/core/extensions/index.ts";
import { validateAnswers, validateQuestions } from "../src/extensions/ask-user/validate.ts";

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
	return { id: "q1", question: "改 A 还是改 B？", ...overrides };
}

const TWO_OPTIONS = [{ label: "改 A" }, { label: "改 B" }];

describe("validateQuestions", () => {
	it("accepts a minimal single question", () => {
		expect(validateQuestions([question({ options: TWO_OPTIONS })])).toBeUndefined();
	});

	it("accepts a question with no options (free text only)", () => {
		expect(validateQuestions([question()])).toBeUndefined();
	});

	it("rejects an empty batch", () => {
		expect(validateQuestions([])).toContain("至少 1 个");
	});

	it("rejects more than five questions", () => {
		const many = Array.from({ length: 6 }, (_, i) => question({ id: `q${i}` }));
		expect(validateQuestions(many)).toContain("最多 5 个");
	});

	it("rejects a blank id", () => {
		expect(validateQuestions([question({ id: "  " })])).toContain("非空的 id");
	});

	it("rejects duplicate ids", () => {
		expect(validateQuestions([question(), question({ question: "另一个问题" })])).toContain("id 重复");
	});

	it("rejects a blank question text", () => {
		expect(validateQuestions([question({ question: " " })])).toContain("question 为空");
	});

	it("rejects more than six options", () => {
		const options = Array.from({ length: 7 }, (_, i) => ({ label: `选项${i}` }));
		expect(validateQuestions([question({ options })])).toContain("最多 6 个");
	});

	it("rejects a blank option label", () => {
		expect(validateQuestions([question({ options: [{ label: " " }] })])).toContain("空的选项 label");
	});

	it("rejects an over-long option label", () => {
		const label = "x".repeat(41);
		expect(validateQuestions([question({ options: [{ label }] })])).toContain("超过 40 字符");
	});

	it("rejects duplicate option labels within one question", () => {
		expect(validateQuestions([question({ options: [{ label: "改 A" }, { label: "改 A" }] })])).toContain(
			"选项 label 重复",
		);
	});

	it("allows the same label in two different questions", () => {
		const questions = [
			question({ id: "q1", options: [{ label: "是" }, { label: "否" }] }),
			question({ id: "q2", question: "要跑测试吗？", options: [{ label: "是" }, { label: "否" }] }),
		];
		expect(validateQuestions(questions)).toBeUndefined();
	});
});

describe("validateAnswers", () => {
	const single = question({ options: TWO_OPTIONS });
	const multi = question({ id: "q2", options: TWO_OPTIONS, multiSelect: true });
	const freeText = question({ id: "q3" });

	function check(questions: AskUserQuestion[], answers: AskUserAnswerItem[]) {
		return validateAnswers(questions, answers);
	}

	it("accepts one selected label for a single-select question", () => {
		expect(check([single], [{ id: "q1", selected: ["改 A"] }])).toBeUndefined();
	});

	it("accepts an empty selection as an explicit skip", () => {
		expect(check([single], [{ id: "q1", selected: [] }])).toBeUndefined();
	});

	it("accepts custom text alone for a single-select question", () => {
		expect(check([single], [{ id: "q1", selected: [], custom: "都不改" }])).toBeUndefined();
	});

	it("accepts custom text for a question with no options", () => {
		expect(check([freeText], [{ id: "q3", selected: [], custom: "用 lib/ask-user.ts" }])).toBeUndefined();
	});

	it("accepts several labels plus custom text for a multi-select question", () => {
		expect(check([multi], [{ id: "q2", selected: ["改 A", "改 B"], custom: "顺带补测试" }])).toBeUndefined();
	});

	it("rejects a batch whose length differs from the questions", () => {
		expect(check([single, multi], [{ id: "q1", selected: [] }])).toContain("期望 2 条答案");
	});

	it("rejects answers that are out of question order", () => {
		const answers: AskUserAnswerItem[] = [
			{ id: "q2", selected: [] },
			{ id: "q1", selected: [] },
		];
		expect(check([single, multi], answers)).toContain("期望 q1");
	});

	it("rejects a label that belongs to another question", () => {
		const questions = [single, question({ id: "q2", options: [{ label: "跑测试" }] })];
		const answers: AskUserAnswerItem[] = [
			{ id: "q1", selected: ["跑测试"] },
			{ id: "q2", selected: [] },
		];
		expect(check(questions, answers)).toContain("不属于该问的选项");
	});

	it("rejects a label that is not among any options", () => {
		expect(check([single], [{ id: "q1", selected: ["改 C"] }])).toContain("不属于该问的选项");
	});

	it("rejects duplicate labels in one selection", () => {
		expect(check([multi], [{ id: "q2", selected: ["改 A", "改 A"] }])).toContain("重复选项");
	});

	it("rejects two selections for a single-select question", () => {
		expect(check([single], [{ id: "q1", selected: ["改 A", "改 B"] }])).toContain("是单选");
	});

	it("rejects selection plus custom text for a single-select question", () => {
		expect(check([single], [{ id: "q1", selected: ["改 A"], custom: "但要小心" }])).toContain(
			"选项与自由文本不能同时给出",
		);
	});

	it("rejects blank custom text (a skip must not carry one)", () => {
		expect(check([single], [{ id: "q1", selected: [], custom: "   " }])).toContain("自由文本为空");
	});
});
