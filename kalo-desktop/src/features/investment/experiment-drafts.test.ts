import { describe, expect, it } from "vitest";
import { copyExperiment, parseDrafts, putDraft } from "./experiment-drafts";
import type { ScriptSpec } from "./code-types";

const spec: ScriptSpec = { datasetId: "frozen", title: "自定义策略", source: "fn on_bar(ctx) {}", start: "start", end: "end", cash: 123456, basePosition: 700, tradeSize: 300, commissionBps: 1.7, minimumFee: 3, slippageBps: 2 };
const date = "2026-11-03T10:00:00Z";
describe("independent experiment drafts", () => {
  it("keeps two strategies on the same dataset and updates only the chosen draft", () => {
    const a = copyExperiment("a", date, spec), b = copyExperiment("b", date, { ...spec, source: "other code" });
    const drafts = putDraft(putDraft([], a), b);
    const updated = putDraft(drafts, { ...a, spec: { ...a.spec, title: "修改" } });
    expect(updated).toHaveLength(2);
    expect(updated.find(d => d.id === "b")).toEqual(b);
    expect(a.spec.title).toBe("自定义策略");
    expect(parseDrafts(JSON.stringify({ version: 1, drafts: updated }))).toEqual(updated);
  });
  it("copies every report parameter without sharing the original spec", () => {
    const draft = copyExperiment("new", date, spec);
    expect(draft.spec).toEqual(spec);
    draft.spec.source = "edited";
    expect(spec.source).toBe("fn on_bar(ctx) {}");
  });
  it("refuses corrupt, duplicate, non-finite and future-format storage instead of overwriting it", () => {
    expect(parseDrafts(null)).toEqual([]);
    const draft = copyExperiment("a", date, spec);
    for (const raw of ["{broken", JSON.stringify({ version: 2, drafts: [] }), JSON.stringify({ version: 1, drafts: [draft, draft] }), JSON.stringify({ version: 1, drafts: [{ ...draft, spec: { ...spec, cash: null } }] })]) expect(() => parseDrafts(raw)).toThrow();
  });
});
