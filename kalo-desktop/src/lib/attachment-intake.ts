/**
 * 附件摄取：把「路径」「剪贴板 File」变成 composer 上的 AttachmentDraft。
 *
 * 从 chat-store 抽出来的一层（chat-store.ts 已超行数预算，只许缩），这里只依赖
 * pi-bridge 与纯 helper，不碰 store 的私有状态：读不动的文件通过 `warn` 回报，
 * 由调用方决定怎么提示用户。
 */

import { fileToBase64, pastedImageName, uniqueAttachmentName } from "./chat-store-helpers";
import { readAttachment, saveAttachmentBytes } from "./pi-bridge";
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
 * webview 的 File 对象（粘贴/拖拽进来的字节，没有路径）：图片留在内存里，其余写进
 * `~/.kalo/attachments` 换一个模型能读的路径。
 */
export async function readFileDrafts(files: File[], warn: Warn): Promise<AttachmentDraft[]> {
  const drafts: AttachmentDraft[] = [];
  for (const file of files) {
    try {
      const base64 = await fileToBase64(file);
      if (file.type.startsWith("image/")) {
        drafts.push({ kind: "image", name: pastedImageName(file), mimeType: file.type, dataBase64: base64 });
      } else {
        drafts.push(await saveAttachmentBytes(file.name, base64));
      }
    } catch (err) {
      warn(`无法添加附件 ${file.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return drafts;
}

/**
 * 追加一个草稿，重名时改名——`name` 是 chip 的身份。同一个路径加两次是 no-op：
 * 那会让同一个文件以两个 chip 名进 `<attachments>` 标签两次。
 */
export function appendAttachment(existing: AttachmentDraft[], draft: AttachmentDraft): AttachmentDraft[] {
  if (draft.kind === "file" && existing.some((a) => a.kind === "file" && a.path === draft.path)) return existing;
  const name = uniqueAttachmentName(draft.name, existing);
  return [...existing, name === draft.name ? draft : { ...draft, name }];
}
