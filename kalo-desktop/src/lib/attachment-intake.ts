/**
 * 附件摄取：把「路径」「剪贴板 File」变成 composer 上的 AttachmentDraft。
 *
 * 从 chat-store 抽出来的一层（chat-store.ts 已超行数预算，只许缩），这里只依赖
 * pi-bridge 与纯 helper，不碰 store 的私有状态：读不动的文件通过 `warn` 回报，
 * 由调用方决定怎么提示用户。
 */

import { fileToBase64, pastedImageName, uniqueAttachmentName } from "./chat-store-helpers";
import { clipboardFilePaths, readAttachment, saveAttachmentBytes } from "./pi-bridge";
import { attachmentPathKey } from "./paste";
import type { AttachmentDraft } from "../types";

type Warn = (message: string) => void;

/** 逐个路径读成草稿；读不动的文件跳过并回报，不中断其余路径。 */
export async function readAttachmentDrafts(paths: string[], warn: Warn): Promise<AttachmentDraft[]> {
  const drafts: AttachmentDraft[] = [];
  for (const path of paths) {
    try {
      const draft = await readAttachment(path);
      // 文件草稿自带路径；图片要单独记住来源，chip 的 tooltip 要用。
      drafts.push(draft.kind === "image" ? { ...draft, sourcePath: path } : draft);
    } catch (err) {
      warn(`无法添加附件 ${path}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return drafts;
}

/**
 * 没有原路径的字节附件统一持久保存；图片另外保留模型输入和预览。
 */
export async function readFileDrafts(files: File[], warn: Warn): Promise<AttachmentDraft[]> {
  const drafts: AttachmentDraft[] = [];
  for (const file of files) {
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("粘贴附件最多 32 MB；已有文件可通过选择或拖入引用原路径");
      const base64 = await fileToBase64(file);
      const saved = await saveAttachmentBytes(file.type.startsWith("image/") ? pastedImageName(file) : file.name, base64);
      if (saved.kind !== "file") throw new Error("附件保存未返回路径，请重试");
      if (file.type.startsWith("image/")) {
        drafts.push(file.size <= 10 * 1024 * 1024
          ? { kind: "image", name: saved.name, mimeType: file.type, dataBase64: base64, sourcePath: saved.path }
          : saved);
      } else {
        drafts.push(saved);
      }
    } catch (err) {
      warn(`无法添加附件 ${file.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return drafts;
}

/** OS file-copy uses original paths; clipboard bitmaps always get a durable copy. */
export async function readClipboardDrafts(files: File[], uriPaths: string[], warn: Warn): Promise<AttachmentDraft[]> {
  let paths = uriPaths;
  if (!paths.length) {
    try { paths = await clipboardFilePaths(); }
    catch (err) { if (!files.length) warn(String(err)); }
  }
  // The OS clipboard may have changed since this paste event. Do not attach
  // an unrelated native file list in place of the event's bytes.
  if (files.length && !files.every((file) => paths.some((path) => path.split(/[\\/]/).at(-1) === file.name))) paths = [];
  if (!paths.length) return readFileDrafts(files, warn);
  const drafts = await readAttachmentDrafts(paths, warn);
  const result: AttachmentDraft[] = [];
  for (const draft of drafts) {
    if (draft.kind !== "image") { result.push(draft); continue; }
    try {
      const saved = await saveAttachmentBytes(draft.name, draft.dataBase64);
      if (saved.kind === "file") result.push({ ...draft, sourcePath: saved.path });
    } catch (err) { warn(`无法保存粘贴图片 ${draft.name}：${String(err)}，请重新粘贴`); }
  }
  return result;
}

/**
 * 追加一个草稿，重名时改名——`name` 是 chip 的身份。同一个路径加两次是 no-op：
 * 那会让同一个文件以两个 chip 名进 `<attachments>` 标签两次。
 */
export function appendAttachment(existing: AttachmentDraft[], draft: AttachmentDraft): AttachmentDraft[] {
  const path = draft.kind === "file" ? draft.path : draft.sourcePath;
  if (path && existing.some((a) => {
    const other = a.kind === "file" ? a.path : a.sourcePath;
    return other && attachmentPathKey(other) === attachmentPathKey(path);
  })) return existing;
  const name = uniqueAttachmentName(draft.name, existing);
  return [...existing, name === draft.name ? draft : { ...draft, name }];
}
