import { writeKnowledgeCard } from "../../lib/pi-bridge";
import { waitForNoteWrites } from "../notes/useNoteDocument";

export interface PendingDraft { path: string; text: string }
const prefix = "kalo.notes.draft.";

/** Failed autosaves retain their draft; no draft is silently discarded to enter maintenance. */
export async function pendingDrafts(): Promise<PendingDraft[]> {
  await waitForNoteWrites();
  return Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => ({ path: key.slice(prefix.length), text: localStorage.getItem(key) ?? "" }));
}

export async function preserveDraft(draft: PendingDraft): Promise<void> {
  await writeKnowledgeCard(undefined, "cards", `recovered-${crypto.randomUUID()}`, draft.text);
  if (localStorage.getItem(prefix + draft.path) === draft.text) localStorage.removeItem(prefix + draft.path);
}
