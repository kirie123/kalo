import { useState } from "react";
import { basename, parseAttachmentTag } from "../lib/attachments";
import { openPath } from "../lib/pi-bridge";
import type { ImageContent, UserMessage } from "../types";
import CopyButton from "./CopyButton";
import ImageLightbox, { type LightboxImage } from "./ImageLightbox";

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function userImages(message: UserMessage): ImageContent[] {
  if (typeof message.content === "string") return [];
  return message.content.filter((c): c is ImageContent => c.type === "image");
}

export default function UserBubble({ message }: { message: UserMessage }) {
  const [preview, setPreview] = useState<LightboxImage | null>(null);
  // Attached files travel as paths in an <attachments> tag; render them as
  // chips instead of dumping the tag into the bubble as text.
  const { text, paths } = parseAttachmentTag(userText(message));
  const images = userImages(message);

  return (
    <div className="group flex flex-col items-end py-1">
      {(paths.length > 0 || images.length > 0) && (
        <div className="flex max-w-[75%] flex-wrap justify-end gap-1.5 pb-1">
          {images.map((img, i) => (
            <button
              key={`img-${i}`}
              title="点击查看大图"
              onClick={() => setPreview({ name: `图片 ${i + 1}`, mimeType: img.mimeType, dataBase64: img.data })}
              className="flex cursor-zoom-in items-center rounded-md border border-edge bg-card p-1"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`图片 ${i + 1}`}
                className="size-8 rounded object-cover"
              />
            </button>
          ))}
          {paths.map((path) => (
            <button
              key={path}
              title={`${path}\n点击用系统默认程序打开`}
              onClick={() => void openPath(path)}
              className="flex min-w-0 items-center gap-1.5 rounded-md border border-edge bg-card px-2 py-1 text-xs text-dim hover:text-ink"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                className="shrink-0"
              >
                <path d="M4 1.5h5L12.5 5v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z" strokeLinejoin="round" />
                <path d="M9 1.5V5h3.5" strokeLinejoin="round" />
              </svg>
              <span className="max-w-48 truncate">{basename(path)}</span>
            </button>
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-[var(--bubble)] px-3.5 py-2 text-sm leading-relaxed">
          {text}
        </div>
      )}
      <div className="pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={text} title="复制这条输入" />
      </div>
      {preview && <ImageLightbox image={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
