import { useLayoutEffect, useRef, useState } from "react";
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

/** Collapsed height cap (px) for a long user message — roughly 12 lines. */
const COLLAPSED_MAX_H = 260;

/**
 * User text with a default height cap. When the text overflows, the bottom is
 * clipped behind a gradient and an 展开/收起 button sits inside the bubble's
 * bottom-right corner (revealed on hover). Short messages render unchanged.
 */
function CollapsibleText({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Wrapping depends on width and chat zoom, so measure on resize rather than
  // only once on mount.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSED_MAX_H + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const clamped = overflowing && !expanded;

  return (
    <div
      className={`group/bubble relative max-w-[75%] overflow-hidden rounded-2xl bg-[var(--bubble)] px-3.5 py-2 text-sm leading-relaxed ${
        overflowing && expanded ? "pb-7" : ""
      }`}
    >
      <div
        ref={bodyRef}
        className="whitespace-pre-wrap"
        style={clamped ? { maxHeight: COLLAPSED_MAX_H, overflow: "hidden" } : undefined}
      >
        {text}
      </div>
      {clamped && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-[var(--bubble)]" />
      )}
      {overflowing && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="absolute bottom-1.5 right-2 rounded-md border border-edge bg-card px-1.5 py-0.5 text-[11px] text-dim opacity-0 shadow-sm transition-opacity hover:text-ink group-hover/bubble:opacity-100"
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
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
      {text && <CollapsibleText text={text} />}
      <div className="pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={text} title="复制这条输入" />
      </div>
      {preview && <ImageLightbox image={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
