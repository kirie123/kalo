import { readFileBytes, saveAttachmentBytes } from "../../lib/pi-bridge";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

async function persistImage(name: string, data: string): Promise<{ path: string; name: string }> {
  const saved = await saveAttachmentBytes(name, data);
  if (saved.kind !== "file") throw new Error("图片未能保存为本地附件，请重试");
  return { path: saved.path, name };
}

/** Tauri's native drag/drop supplies paths rather than browser File objects. */
export async function copyNoteImage(path: string): Promise<{ path: string; name: string }> {
  const file = await readFileBytes(path, MAX_IMAGE_BYTES);
  if (!extensions[file.mimeType]) throw new Error("请选择 PNG、JPEG、GIF 或 WebP 图片");
  if (file.truncated || file.size > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB，请压缩后重试");
  return persistImage(path.replace(/\\/g, "/").split("/").pop() || `image.${extensions[file.mimeType]}`, file.dataBase64);
}

/** Image import is a browser/IPC adapter. The returned path points to a durable copy. */
export async function importNoteImage(file: File): Promise<{ path: string; name: string }> {
  const extension = extensions[file.type];
  if (!extension) throw new Error("请选择 PNG、JPEG、GIF 或 WebP 图片");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB，请压缩后重试");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图片，请重新选择"));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
  const name = /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name : `${file.name || "image"}.${extension}`;
  return persistImage(name, data);
}
