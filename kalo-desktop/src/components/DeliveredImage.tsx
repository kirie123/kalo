import { useEffect, useState } from "react";
import { resolveImageSource } from "../lib/delivered-image";
import { readFileBytes } from "../lib/pi-bridge";
import ImageLightbox from "./ImageLightbox";

/** Inline-safe markup: Markdown images can occur inside paragraphs and links. */
export default function DeliveredImage({ source, alt = "图片", title, onOpen }: { source: string; alt?: string; title?: string; onOpen?: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const openImage = () => { if (onOpen) onOpen(); else setOpen(true); };
  useEffect(() => {
    let alive = true;
    setUrl(""); setError(""); setOpen(false);
    const resolved = resolveImageSource(source);
    if (!resolved) { setError("无法加载图片，请使用绝对文件路径或 HTTP(S) 图片链接"); return; }
    if (resolved.kind === "url") setUrl(resolved.url);
    else void readFileBytes(resolved.path).then((data) => {
      if (!alive) return;
      if (data.truncated) throw new Error("图片过大，请用默认程序打开");
      if (!data.mimeType.startsWith("image/")) throw new Error("文件不是可预览的图片");
      setUrl(`data:${data.mimeType};base64,${data.dataBase64}`);
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [source, attempt]);
  return (
    <span className="delivered-image">
      {error ? <span className="text-xs text-dim" role="status">{alt}：{error} <button type="button" onClick={() => setAttempt((n) => n + 1)}>重试</button></span>
        : url ? <img key={attempt} src={url} alt={alt} title={title || (onOpen ? "在右侧文件面板打开" : "点击放大")} loading="lazy" tabIndex={0} role="button" aria-label={`${onOpen ? "打开图片" : "放大图片"}：${alt}`}
          onClick={(e) => { e.preventDefault(); openImage(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImage(); } }}
          onError={() => setError("图片解码失败或链接不可用")} />
          : <span className="text-xs text-dim" role="status">正在加载{alt}…</span>}
      {open && <ImageLightbox image={{ name: alt, src: url }} onClose={() => setOpen(false)} />}
    </span>
  );
}
