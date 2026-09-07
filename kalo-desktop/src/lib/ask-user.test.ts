import { describe, expect, it } from "vitest";
import {
  canSubmit,
  createAskState,
  currentDraft,
  encodeAnswers,
  goTo,
  isAnswered,
  setCustom,
  setCustomOpen,
  skipCurrent,
  toggleOption,
  validateEncoded,
} from "./ask-user";
import type { AskUserQuestion } from "../types";

const OPTIONS = [{ label: "改 A" }, { label: "改 B" }];

function single(id = "q1"): AskUserQuestion {
  return { id, question: "改哪个？", options: OPTIONS };
}

function multi(id = "q2"): AskUserQuestion {
  return { id, question: "顺带做什么？", options: OPTIONS, multiSelect: true };
}

function freeText(id = "q3"): AskUserQuestion {
  return { id, question: "文件放哪？" };
}

function start(...questions: AskUserQuestion[]) {
  return createAskState("req-1", questions);
}

describe("single-select", () => {
  it("selects and advances in one click", () => {
    const state = toggleOption(start(single(), multi()), "改 A");
    expect(state.drafts[0].selected).toEqual(["改 A"]);
    expect(state.index).toBe(1);
  });

  it("stays on the last question after selecting", () => {
    const state = toggleOption(start(single()), "改 A");
    expect(state.index).toBe(0);
  });

  it("replaces the previous choice rather than accumulating", () => {
    let state = start(single());
    state = toggleOption(state, "改 A");
    state = toggleOption(goTo(state, 0), "改 B");
    expect(state.drafts[0].selected).toEqual(["改 B"]);
  });

  it("clears the selection when free text is typed", () => {
    let state = toggleOption(start(single()), "改 A");
    state = setCustom(goTo(state, 0), "都不改");
    expect(currentDraft(state).selected).toEqual([]);
    expect(currentDraft(state).custom).toBe("都不改");
  });

  it("clears free text when an option is picked", () => {
    let state = setCustom(start(single()), "都不改");
    state = toggleOption(state, "改 A");
    expect(state.drafts[0].custom).toBe("");
    expect(state.drafts[0].selected).toEqual(["改 A"]);
  });
});

describe("multi-select", () => {
  it("accumulates options and does not advance", () => {
    let state = start(multi(), single());
    state = toggleOption(state, "改 A");
    state = toggleOption(state, "改 B");
    expect(state.drafts[0].selected).toEqual(["改 A", "改 B"]);
    expect(state.index).toBe(0);
  });

  it("toggles a selected option off", () => {
    let state = toggleOption(start(multi()), "改 A");
    state = toggleOption(state, "改 A");
    expect(currentDraft(state).selected).toEqual([]);
  });

  it("keeps both options and free text", () => {
    let state = toggleOption(start(multi()), "改 A");
    state = setCustom(state, "再补测试");
    expect(currentDraft(state).selected).toEqual(["改 A"]);
    expect(encodeAnswers(state)[0]).toEqual({ id: "q2", selected: ["改 A"], custom: "再补测试" });
  });
});

describe("free-text-only questions", () => {
  it("counts as answered once text is typed", () => {
    const state = setCustom(start(freeText()), "src/lib/ask-user.ts");
    expect(isAnswered(freeText(), currentDraft(state))).toBe(true);
  });

  it("is unanswered while the text is blank", () => {
    const state = setCustom(start(freeText()), "   ");
    expect(canSubmit(state)).toBe(false);
  });

  it("drops blank free text from the encoded batch", () => {
    const state = setCustom(start(freeText()), "   ");
    expect(encodeAnswers(state)[0]).toEqual({ id: "q3", selected: [] });
  });
});

describe("skipping", () => {
  it("encodes a skip as an empty selection", () => {
    const state = skipCurrent(start(single()));
    expect(encodeAnswers(state)[0]).toEqual({ id: "q1", selected: [] });
  });

  it("counts a skip as answered so the batch can be submitted", () => {
    const state = skipCurrent(start(single()));
    expect(canSubmit(state)).toBe(true);
  });

  it("keeps earlier answers when a later question is skipped", () => {
    let state = toggleOption(start(single(), multi()), "改 A");
    state = skipCurrent(state);
    expect(encodeAnswers(state)).toEqual([
      { id: "q1", selected: ["改 A"] },
      { id: "q2", selected: [] },
    ]);
  });

  it("advances past the skipped question", () => {
    const state = skipCurrent(start(single(), multi()));
    expect(state.index).toBe(1);
  });
});

describe("submission gate", () => {
  it("blocks until every question has an answer or a skip", () => {
    let state = start(single(), multi());
    expect(canSubmit(state)).toBe(false);
    state = toggleOption(state, "改 A");
    expect(canSubmit(state)).toBe(false);
    state = toggleOption(state, "改 B");
    expect(canSubmit(state)).toBe(true);
  });
});

describe("encodeAnswers", () => {
  it("keeps question order regardless of the order answered", () => {
    let state = start(single("a"), multi("b"), freeText("c"));
    state = goTo(state, 2);
    state = setCustom(state, "lib");
    state = goTo(state, 0);
    state = toggleOption(state, "改 A");
    state = goTo(state, 1);
    state = toggleOption(state, "改 B");

    expect(encodeAnswers(state).map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("omits custom entirely when there is none (rather than sending an empty string)", () => {
    const state = toggleOption(start(single()), "改 A");
    expect("custom" in encodeAnswers(state)[0]).toBe(false);
  });

  it("produces a batch the engine's rules accept", () => {
    let state = start(single("a"), multi("b"), freeText("c"));
    state = toggleOption(state, "改 A");
    state = toggleOption(state, "改 A");
    state = setCustom(state, "都行");
    state = goTo(state, 2);
    state = setCustom(state, "lib");

    expect(validateEncoded(state.questions, encodeAnswers(state))).toBeUndefined();
  });
});

describe("setCustomOpen", () => {
  it("drops the free text when the field is closed again", () => {
    let state = setCustom(start(single()), "都不改");
    state = setCustomOpen(state, false);
    expect(currentDraft(state).custom).toBe("");
    expect(currentDraft(state).customOpen).toBe(false);
  });

  it("clears a single-select choice when the field is opened", () => {
    let state = toggleOption(start(single()), "改 A");
    state = setCustomOpen(goTo(state, 0), true);
    expect(currentDraft(state).selected).toEqual([]);
  });

  it("keeps multi-select choices when the field is opened", () => {
    let state = toggleOption(start(multi()), "改 A");
    state = setCustomOpen(state, true);
    expect(currentDraft(state).selected).toEqual(["改 A"]);
  });
});

describe("validateEncoded", () => {
  it("rejects a batch of the wrong length", () => {
    expect(validateEncoded([single()], [])).toContain("期望 1 条答案");
  });

  it("rejects an out-of-order batch", () => {
    const answers = [
      { id: "q2", selected: [] },
      { id: "q1", selected: [] },
    ];
    expect(validateEncoded([single(), multi()], answers)).toContain("id 不匹配");
  });

  it("rejects a label that is not an option of that question", () => {
    expect(validateEncoded([single()], [{ id: "q1", selected: ["改 C"] }])).toContain("不属于该问的选项");
  });

  it("rejects two options for a single-select question", () => {
    expect(validateEncoded([single()], [{ id: "q1", selected: ["改 A", "改 B"] }])).toContain("是单选");
  });

  it("rejects an option plus free text for a single-select question", () => {
    expect(validateEncoded([single()], [{ id: "q1", selected: ["改 A"], custom: "但是" }])).toContain(
      "不能同时给出",
    );
  });

  it("accepts an empty selection as a skip", () => {
    expect(validateEncoded([single()], [{ id: "q1", selected: [] }])).toBeUndefined();
  });
});
