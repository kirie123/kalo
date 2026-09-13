import { useEffect, useRef, useState } from "react";
import { chatStore, useChatSelector } from "../lib/chat-store";
import { queuedPreview, type QueuedInput } from "../lib/input-queue";
import ImageLightbox, { type LightboxImage } from "./ImageLightbox";

/**
 * 输入队列（doc/2026-09-13-输入队列.md）：运行中敲下的消息排在输入框上方，默认等
 * 本轮跑完再依次发出。每条是一个条形控件——左侧是内容（图片缩略图 + 文本预览），
 * 右侧是投递方式下拉（等执行完 / 立即插入）与删除。
 *
 * 空队列时不渲染任何东西：不打扰只想说一句话的人。
 */
export default function InputQueue() {
  const { queue, isStreaming } = useChatSelector((s) => ({
    queue: s.inputQueue,
    isStreaming: s.isStreaming || s.isCompacting,
  }));
  const [previewImage, setPreviewImage] = useState<LightboxImage | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[11px] text-dim">
        <QueueIcon />
        <span>
          排队中 {queue.length} 条 · {isStreaming ? "本轮结束后依次发送" : "会话已空闲，可逐条立即发送"}
        </span>
      </div>
      {queue.map((item, i) => (
        <QueueRow
          key={item.id}
          item={item}
          index={i + 1}
          isStreaming={isStreaming}
          onPreviewImage={setPreviewImage}
        />
      ))}
      {previewImage && <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
}

function QueueRow({
  item,
  index,
  isStreaming,
  onPreviewImage,
}: {
  item: QueuedInput;
  index: number;
  isStreaming: boolean;
  onPreviewImage: (img: LightboxImage) => void;
}) {
  const images = item.attachments.filter((a) => a.kind === "image");
  const files = item.attachments.filter((a) => a.kind === "file");
  const preview = queuedPreview(item);

  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge bg-card px-2.5 py-1.5">
      <span className="mono shrink-0 text-[11px] text-dim">{index}</span>

      {images.map((a) =>
        a.kind === "image" ? (
          <button
            key={a.name}
            onClick={() => onPreviewImage(a)}
            title={`${a.name}\n点击查看大图`}
            className="shrink-0 cursor-zoom-in"
          >
            <img
              src={`data:${a.mimeType};base64,${a.dataBase64}`}
              alt={a.name}
              className="size-6 rounded object-cover"
            />
          </button>
        ) : null,
      )}
      {files.length > 0 && (
        <span
          title={files.map((f) => (f.kind === "file" ? f.path : f.name)).join("\n")}
          className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[11px] text-dim"
        >
          {files.length === 1 ? files[0].name : `${files.length} 个文件`}
        </span>
      )}

      {/* 正文：点一下退回输入框继续编辑（条目出队，附件回到 composer）。 */}
      <button
        onClick={() => chatStore.editQueuedInput(item.id)}
        title={`${item.text || "（无文本）"}\n\n点击退回输入框编辑`}
        className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-accent"
      >
        {preview}
      </button>

      <DeliveryPicker onImmediate={() => void chatStore.sendQueuedInput(item.id)} isStreaming={isStreaming} />

      <button
        onClick={() => chatStore.dropQueuedInput(item.id)}
        title="从队列移除"
        className="shrink-0 rounded p-1 text-dim hover:bg-base hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * 投递方式选择：当前态是「等执行完」，选「立即插入」即刻把这条 steer 进当前轮
 * （条目随即离开队列）。做成下拉而不是两个并排按钮，是因为这一行本来就窄，而
 * 「立即插入」是会打断模型的动作，值得多一步确认式的点击。
 */
function DeliveryPicker({ onImmediate, isStreaming }: { onImmediate: () => void; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="投递方式"
        className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-dim hover:bg-base hover:text-ink"
      >
        <span>{isStreaming ? "等执行完" : "待发送"}</span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1.5 w-60 overflow-hidden rounded-lg border border-edge bg-card py-1 shadow-lift">
          <button
            onClick={() => setOpen(false)}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-base"
          >
            <span className="w-3 shrink-0 pt-px text-center text-[var(--ok)]">✓</span>
            <span className="min-w-0">
              <span className="block text-xs text-ink">等执行完</span>
              <span className="block text-[11px] text-dim">本轮结束后自动发送</span>
            </span>
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onImmediate();
            }}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-base"
          >
            <span className="w-3 shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs text-tone-orange">
                {isStreaming ? "立即插入（打断当前轮）" : "立即发送"}
              </span>
              <span className="block text-[11px] text-dim">
                {isStreaming ? "当前工具调用一结束就送进这一轮" : "会话已空闲，马上发出去"}
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function QueueIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M2.5 4.5h11M2.5 8h8M2.5 11.5h5" strokeLinecap="round" />
    </svg>
  );
}
