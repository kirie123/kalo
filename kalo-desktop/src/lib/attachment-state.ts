import type { AttachmentDraft } from "../types";

export interface AttachmentState {
  attachments: AttachmentDraft[];
  attachmentPending: number;
  inputDraft?: string;
}

/** Capture get/update for the originating session, never look up the active chat after await. */
export async function ingestAttachments(
  read: () => Promise<AttachmentDraft[]>,
  get: () => AttachmentState,
  update: (patch: Partial<AttachmentState>) => void,
  append: (existing: AttachmentDraft[], draft: AttachmentDraft) => AttachmentDraft[],
  warn: (message: string) => void,
  fallbackText?: string,
): Promise<void> {
  update({ attachmentPending: get().attachmentPending + 1 });
  try {
    const drafts = await read();
    if (!drafts.length && fallbackText !== undefined) update({ inputDraft: fallbackText });
    update({ attachments: drafts.reduce(append, get().attachments) });
  } catch (err) {
    warn(`无法添加附件：${String(err)}，请重试`);
    if (fallbackText !== undefined) update({ inputDraft: fallbackText });
  } finally {
    update({ attachmentPending: get().attachmentPending - 1 });
  }
}
