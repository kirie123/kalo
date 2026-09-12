import { save } from "@tauri-apps/plugin-dialog";
import { memo, useMemo, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { writeFileText } from "../lib/pi-bridge";
import { highlight } from "../lib/highlight";
import { hasOwnBackdrop, sanitizeSvg, suggestSvgFileName } from "../lib/svg-render";
import CopyButton from "./CopyButton";

/**
 * One SVG figure in the transcript (doc/2026-09-12-对话区svg渲染.md).
 *
 * Renders the sanitized markup, with a source toggle and an export. When the
 * source cannot be rendered safely (oversized / no root tag) it degrades to
 * the source view and says so, rather than showing nothing.
 *
 * Memoized on the source: a streaming message re-renders many times a second
 * and the sanitize pass should not run for figures that are already finished.
 */
const SvgBlock = memo(function SvgBlock({ source, complete = true }: { source: string; complete?: boolean }) {
  const safe = useMemo(() => (complete ? sanitizeSvg(source) : null), [source, complete]);
  // A figure that paints its own background sits on the card directly; a
  // transparent one gets a light backdrop, or dark strokes vanish in dark mode.
  const ownBackdrop = useMemo(() => complete && hasOwnBackdrop(source), [source, complete]);
  const [showSource, setShowSource] = useState(false);

  if (!complete) {
    return (
      <div className="svg-block">
        <div className="svg-block-bar">
          <span className="svg-block-label">SVG</span>
        </div>
        <div className="svg-block-pending">
          <span className="spinner" />
          <span>正在生成图形…</span>
        </div>
      </div>
    );
  }

  const renderable = safe !== null;
  const asSource = showSource || !renderable;

  const exportSvg = () => {
    void (async () => {
      try {
        const path = await save({
          defaultPath: suggestSvgFileName(source),
          filters: [{ name: "SVG", extensions: ["svg"] }],
        });
        if (!path) return;
        await writeFileText(path, source);
        chatStore.pushToast(`已保存到 ${path}`, "info");
      } catch (err) {
        chatStore.pushToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    })();
  };

  return (
    <div className="svg-block">
      <div className="svg-block-bar">
        <span className="svg-block-label">{renderable ? "SVG" : "SVG（无法渲染，仅显示源码）"}</span>
        <span className="flex items-center gap-1">
          {renderable && (
            <button onClick={() => setShowSource((v) => !v)} title={showSource ? "显示图形" : "显示源码"}>
              {showSource ? "预览" : "源码"}
            </button>
          )}
          <CopyButton text={source} title="复制 SVG 源码" />
          <button onClick={exportSvg} title="另存为 .svg">
            另存为
          </button>
        </span>
      </div>
      {asSource ? (
        <pre className="svg-block-source">
          <code dangerouslySetInnerHTML={{ __html: highlight(source, "xml") }} />
        </pre>
      ) : (
        // Sanitized in svg-render.ts: scripts, event handlers and off-document
        // refs are gone before this point.
        <div
          className={`svg-block-canvas ${ownBackdrop ? "svg-block-canvas--own-bg" : ""}`}
          dangerouslySetInnerHTML={{ __html: safe! }}
        />
      )}
    </div>
  );
});

export default SvgBlock;
