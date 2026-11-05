import { describe, expect, it } from "vitest";
import type { AttachmentDraft } from "../types";
import { ingestAttachments, type AttachmentState } from "./attachment-state";

const state = (): AttachmentState => ({ attachments: [], attachmentPending: 0 });
const append = (existing: AttachmentDraft[], draft: AttachmentDraft) => [...existing, draft];

describe("attachment intake ownership", () => {
  it("keeps concurrent results in the captured session and holds the send gate until both finish", async () => {
    const original = state(), other = state();
    let active = original;
    const target = active;
    const update = (patch: Partial<AttachmentState>) => Object.assign(target, patch);
    let finishFirst!: (drafts: AttachmentDraft[]) => void;
    let finishSecond!: (drafts: AttachmentDraft[]) => void;
    const first = ingestAttachments(() => new Promise((done) => { finishFirst = done; }), () => target, update, append, () => {});
    const second = ingestAttachments(() => new Promise((done) => { finishSecond = done; }), () => target, update, append, () => {});
    active = other;
    expect(original.attachmentPending).toBe(2);
    finishSecond([{ kind: "file", name: "b.txt", path: "/b.txt" }]);
    await second;
    expect(original.attachmentPending).toBe(1);
    finishFirst([{ kind: "file", name: "a.txt", path: "/a.txt" }]);
    await first;
    expect(original.attachments.map((a) => a.name)).toEqual(["b.txt", "a.txt"]);
    expect(original.attachmentPending).toBe(0);
    expect(active.attachments).toEqual([]);
  });

  it("preserves the exact recovery draft after a failed save", async () => {
    const target = state();
    const original = "before\n  粘贴\r\n\nafter";
    const warnings: string[] = [];
    await ingestAttachments(async () => { throw new Error("disk full"); }, () => target,
      (patch) => Object.assign(target, patch), append, (warning) => warnings.push(warning), original);
    expect(target.inputDraft).toBe(original);
    expect(target.attachmentPending).toBe(0);
    expect(warnings[0]).toContain("disk full");
    expect(target.attachments).toEqual([]);
  });
});
