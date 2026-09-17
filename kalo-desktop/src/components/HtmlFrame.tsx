import { useEffect, useRef, useState } from "react";
import { chatStore } from "../lib/chat-store";
import {
  BRIDGE_SCRIPT,
  collectLocalAssets,
  renderDocHtml,
  unresolvedAssets,
  type BridgeMessage,
  type LocalAsset,
} from "../lib/html-doc";
import { openPath, readFileBytes, readFileText } from "../lib/pi-bridge";

/**
 * One HTML document, rendered in a sandboxed frame (doc/2026-09-17-html预览渲染.md).
 *
 * The document's own assets are unreachable from a webview, so they are read
 * through the app's IPC and spliced in before the frame ever sees the markup —
 * that is what turns "unstyled HTML" into the page the file was written to be.
 * Every `invoke` for this feature lives here.
 *
 * Sandboxing: the frame never gets `allow-same-origin`, so the document lives
 * in an opaque origin with no way back into the app (no parent window, no
 * storage, no Tauri IPC). Scripts are off by default as well: with the
 * `sandbox` attribute left empty, nothing in the frame can execute at all.
 * The reader opts in per file, and even then a remote `<script src="https://…">`
 * stays out (`stripRemoteScripts`).
 */
export default function HtmlFrame({
  path,
  name,
  text,
  allowScripts,
  onOpenPath,
}: {
  path: string;
  name?: string;
  /** Raw file contents; reading it is `FilePreview`'s job. */
  text: string;
  allowScripts: boolean;
  /** Opens a document link in the app. Without it the system handler takes over. */
  onOpenPath?: (path: string) => void;
}) {
  const [doc, setDoc] = useState<string | null>(null);
  const [missing, setMissing] = useState<LocalAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  // Inline every local asset, then hand the assembled document to the frame.
  useEffect(() => {
    let alive = true;
    const assets = collectLocalAssets(text, path).filter((a) => allowScripts || a.kind !== "script");

    void (async () => {
      const inline = new Map<string, string>();
      await Promise.all(
        assets.map(async (asset) => {
          try {
            if (asset.kind === "image") {
              const res = await readFileBytes(asset.path);
              // A half-read image would be a broken data URL; leave the tag be.
              if (!res.truncated && res.dataBase64) {
                inline.set(asset.path, `data:${res.mimeType};base64,${res.dataBase64}`);
              }
            } else {
              const res = await readFileText(asset.path);
              // Truncated CSS/JS is worse than absent: it would silently half-apply.
              if (!res.binary && !res.truncated) inline.set(asset.path, res.text);
            }
          } catch {
            // Reported through `unresolvedAssets` below rather than thrown: one
            // missing icon must not cost the reader the whole document.
          }
        }),
      );
      if (!alive) return;
      try {
        setDoc(renderDocHtml(text, path, { assets, inline, allowScripts }));
        setMissing(unresolvedAssets(assets, inline));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      alive = false;
    };
  }, [text, path, allowScripts]);

  // The document cannot reach us, so it posts; only our own frame counts, which
  // is why identity is checked on the window rather than on an opaque origin.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== frame.current?.contentWindow) return;
      const msg = ev.data as BridgeMessage | null;
      if (!msg || typeof msg !== "object") return;

      if (typeof msg.kaloOpen === "string" && msg.kaloOpen !== "") {
        if (onOpenPath) onOpenPath(msg.kaloOpen);
        else void openPath(msg.kaloOpen).catch((err) => chatStore.pushToast(`打开失败：${err}`, "error"));
      } else if (msg.kaloKey === "Escape") {
        // Re-dispatched rather than handled here: the hosts already listen for
        // Esc on the window (fullscreen exit), and the frame would swallow it.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onOpenPath]);

  if (error) return <div className="p-3 text-xs text-[var(--danger)]">渲染失败：{error}</div>;
  if (doc === null) return <div className="p-3 text-xs text-dim">正在准备文档…</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {missing.length > 0 && (
        <div
          className="shrink-0 truncate border-b border-edge px-2 py-1 text-[10px] text-dim"
          title={missing.map((a) => a.url).join("\n")}
        >
          {missing.length} 个本地资源未能内联：{missing.map((a) => a.url).join("、")}
        </div>
      )}
      <iframe
        // A fresh frame per mode: the document's own state must not survive the
        // switch from "no scripts" to "scripts".
        key={allowScripts ? "scripts" : "static"}
        ref={frame}
        srcDoc={doc}
        // Empty = fully sandboxed (React writes sandbox="" as-is). Never add
        // allow-same-origin: the document must stay outside the app's origin.
        sandbox={allowScripts ? "allow-scripts" : ""}
        title={name ?? path}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
