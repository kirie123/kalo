import { expect, it } from "vitest";
import { createFileRequestGate } from "./file-request-gate";

it("rejects an older refresh without blocking independent directory reads", () => {
  const gate = createFileRequestGate();
  gate.setScope("chat-a:/repo");
  const old = gate.start("dir:/repo");
  const child = gate.start("dir:/repo/src");
  const refresh = gate.start("dir:/repo");
  expect(gate.isCurrent(old)).toBe(false);
  expect(gate.isCurrent(child)).toBe(true);
  expect(gate.isCurrent(refresh)).toBe(true);
});

it("rejects previous-session work even after switching back to the same root", () => {
  const gate = createFileRequestGate();
  gate.setScope("chat-a:/repo");
  const oldGit = gate.start("git");
  const oldDiff = gate.start("diff");
  gate.setScope("chat-b:/repo");
  expect(gate.isCurrent(oldGit)).toBe(false);
  gate.setScope("chat-a:/repo");
  expect(gate.isCurrent(oldDiff)).toBe(false);
  const current = gate.start("git");
  gate.setScope("chat-a:/repo");
  expect(gate.isCurrent(current)).toBe(true);
});
