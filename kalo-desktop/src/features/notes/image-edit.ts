import { noteBlocks, replaceNoteRange } from "./document";

export interface ImageDeletion { body: string; caret: number }

/** Remove only a standalone image reference, preserving all surrounding bytes. */
export function removeNoteImage(body: string, start: number): ImageDeletion | null {
  const image = noteBlocks(body).find((block) => block.kind === "image" && block.start === start);
  return image ? { body: replaceNoteRange(body, image.start, image.end, ""), caret: image.start } : null;
}

export function deleteAdjacentNoteImage(body: string, start: number, end: number, direction: "backward" | "forward"): ImageDeletion | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > body.length) return null;
  const blocks = noteBlocks(body);
  const index = blocks.findIndex((block) => block.kind === "text" && start >= block.start && start <= block.end);
  const text = blocks[index];
  if (!text || text.kind !== "text") return null;
  const backward = direction === "backward";
  const gap = backward ? body.slice(text.start, start) : body.slice(start, text.end);
  const image = blocks[index + (backward ? -1 : 1)];
  if (gap.trim() || image?.kind !== "image") return null;
  const result = removeNoteImage(body, image.start);
  return result && { ...result, caret: backward ? image.start : start };
}
