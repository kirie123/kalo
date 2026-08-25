import { useEffect, useMemo, useRef, useState } from "react";
import { docxToMarkdown } from "../lib/docx";
import { fileKind, formatBytes, needsBytes, type FileKind } from "../lib/file-kind";
import { chatStore } from "../lib/chat-store";
import { openPath, readFileBytes, readFileText } from "../lib/pi-bridge";
import { MAX_COLS, MAX_ROWS, readXlsx, type XlsxWorkbook } from "../lib/xlsx";
import { openZip } from "../lib/zip";
import { MarkdownBlock } from "./AssistantMessage";
import ImageLightbox, { type LightboxImage } from "./ImageLightbox";

/**
 * The one file renderer, shared by the changed-files modal and the file
 * panel's preview column: markdown renders as markdown, images as images,
 * Word/Excel through the in-app OOXML readers, PDFs through the webview's own
 * viewer, and everything else as monospace text.
 *
 * Loading lives here rather than in the hosts so both get the same states
 * (loading / error / too large / not previewable) and neither has to know
 * whether a format needs text or raw bytes.
 */

/** What the loader produced, discriminated the same way as `FileKind`. */
type Loaded =
  | { kind: "markdown" | "text"; text: string; truncated: boolean }
  | { kind: "image"; dataUrl: string; name: string; mimeType: string; dataBase64: string }
  | { kind: "docx"; markdown: string; imageCount: number }
  | { kind: "xlsx"; workbook: XlsxWorkbook }
  | { kind: "pdf"; blobUrl: string }
  | { kind: "opaque"; size: number };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function load(path: string, kind: FileKind): Promise<Loaded> {
  if (!needsBytes(kind)) {
    const res = await readFileText(path);
    // The extension said text but the bytes disagree; trust the bytes.
    if (res.binary) return { kind: "opaque", size: 0 };
    return { kind: kind === "markdown" ? "markdown" : "text", text: res.text, truncated: res.truncated };
  }

  const res = await readFileBytes(path);
  if (res.truncated) throw new Error(`文件过大（${formatBytes(res.size)}），无法在应用内预览`);

  if (kind === "image") {
    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    return {
      kind: "image",
      dataUrl: `data:${res.mimeType};base64,${res.dataBase64}`,
      name,
      mimeType: res.mimeType,
      dataBase64: res.dataBase64,
    };
  }
  if (kind === "pdf") {
    // A blob URL, not a data URL: Chromium refuses to navigate a frame to
    // `data:`, so the built-in PDF viewer would never load.
    const blob = new Blob([base64ToBytes(res.dataBase64) as BlobPart], { type: "application/pdf" });
    return { kind: "pdf", blobUrl: URL.createObjectURL(blob) };
  }

  const zip = openZip(base64ToBytes(res.dataBase64));
  if (kind === "docx") {
    const doc = await docxToMarkdown(zip);
    return { kind: "docx", markdown: doc.markdown, imageCount: doc.imageCount };
  }
  return { kind: "xlsx", workbook: await readXlsx(zip) };
}

export default function FilePreview({ path, name }: { path: string; name?: string }) {
  const kind = useMemo(() => fileKind(path), [path]);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Markdown and docx render by default; this shows the source instead. */
  const [source, setSource] = useState(false);
  // Blob URLs outlive the component unless revoked by hand.
  const blobUrl = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setSource(false);
    load(path, kind).then(
      (res) => {
        if (!alive) {
          if (res.kind === "pdf") URL.revokeObjectURL(res.blobUrl);
          return;
        }
        if (res.kind === "pdf") blobUrl.current = res.blobUrl;
        setData(res);
      },
      (err) => alive && setError(errText(err)),
    );
    return () => {
      alive = false;
      if (blobUrl.current) {
        URL.revokeObjectURL(blobUrl.current);
        blobUrl.current = null;
      }
    };
  }, [path, kind]);

  if (error) {
    return (
      <div className="p-3 text-xs text-[var(--danger)]">
        读取文件失败：{error}
        <OpenExternally path={path} />
      </div>
    );
  }
  if (!data) return <div className="p-3 text-xs text-dim">加载中…</div>;

  switch (data.kind) {
    case "markdown":
      return (
        <div className="relative">
          <SourceToggle source={source} onToggle={() => setSource((v) => !v)} />
          {source ? (
            <PlainText text={data.text} truncated={data.truncated} />
          ) : (
            <div className="px-3 py-2 text-sm">
              <MarkdownBlock text={data.text} />
              {data.truncated && <div className="mt-2 text-xs text-dim">（文件过长，已截断）</div>}
            </div>
          )}
        </div>
      );

    case "text":
      return <PlainText text={data.text} truncated={data.truncated} />;

    case "image":
      return <ImagePreview image={data} />;

    case "docx":
      return (
        <div className="relative">
          <SourceToggle source={source} onToggle={() => setSource((v) => !v)} label="Markdown" />
          {source ? (
            <PlainText text={data.markdown} truncated={false} />
          ) : (
            <div className="px-3 py-2 text-sm">
              {data.markdown ? (
                <MarkdownBlock text={data.markdown} />
              ) : (
                <span className="text-xs text-dim">文档没有可显示的文本内容。</span>
              )}
              {data.imageCount > 0 && (
                <div className="mt-3 text-xs text-dim">
                  文档含 {data.imageCount} 张图片／图形，预览不显示。
                  <OpenExternally path={path} />
                </div>
              )}
            </div>
          )}
        </div>
      );

    case "xlsx":
      return <SheetPreview workbook={data.workbook} />;

    case "pdf":
      return (
        <iframe src={data.blobUrl} title={name ?? path} className="h-full min-h-[60vh] w-full border-0 bg-white" />
      );

    case "opaque":
      return (
        <div className="p-3 text-xs text-dim">
          该格式不支持在应用内预览。
          <OpenExternally path={path} />
        </div>
      );
  }
}

function PlainText({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <pre className="mono whitespace-pre px-3 py-2 text-xs leading-relaxed">
      {text}
      {truncated && "\n（已截断）"}
    </pre>
  );
}

/** Sticky chip that flips a rendered view to its source. */
function SourceToggle({
  source,
  onToggle,
  label = "源码",
}: {
  source: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <div className="pointer-events-none sticky top-0 z-10 flex justify-end px-2 pt-1.5">
      <button
        onClick={onToggle}
        className="pointer-events-auto rounded border border-edge bg-card/90 px-1.5 py-0.5 text-[10px] text-dim hover:text-ink"
      >
        {source ? "渲染" : label}
      </button>
    </div>
  );
}

function ImagePreview({
  image,
}: {
  image: { dataUrl: string; name: string; mimeType: string; dataBase64: string };
}) {
  const [zoom, setZoom] = useState<LightboxImage | null>(null);
  return (
    <div className="flex h-full items-center justify-center p-3">
      <button onClick={() => setZoom(image)} title="点击查看大图" className="cursor-zoom-in">
        <img src={image.dataUrl} alt={image.name} className="max-h-full max-w-full object-contain" />
      </button>
      {zoom && <ImageLightbox image={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** Sheet tabs plus a scrollable grid, with row/column headers like Excel's. */
function SheetPreview({ workbook }: { workbook: XlsxWorkbook }) {
  const [active, setActive] = useState(0);
  const sheet = workbook.sheets[Math.min(active, workbook.sheets.length - 1)];
  const cutRows = sheet.totalRows > MAX_ROWS;
  const cutCols = sheet.totalCols > MAX_COLS;

  return (
    <div className="flex min-h-0 flex-col">
      {workbook.sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-edge px-2 py-1">
          {workbook.sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              onClick={() => setActive(i)}
              title={s.name}
              className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                i === active ? "bg-base text-ink" : "text-dim hover:text-ink"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {sheet.rows.length === 0 ? (
          <div className="p-3 text-xs text-dim">这张工作表是空的。</div>
        ) : (
          <table className="mono w-max border-collapse text-xs">
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r} className={r === 0 ? "bg-base" : undefined}>
                  <td className="sticky left-0 z-10 border border-edge bg-base px-1.5 py-0.5 text-right text-[10px] text-dim">
                    {r + 1}
                  </td>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      title={cell.length > 40 ? cell : undefined}
                      className={`max-w-64 truncate border border-edge px-1.5 py-0.5 ${
                        r === 0 ? "font-medium text-ink" : ""
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(cutRows || cutCols) && (
        <div className="shrink-0 border-t border-edge px-3 py-1 text-[10px] text-dim">
          共 {sheet.totalRows} 行 × {sheet.totalCols} 列，仅显示前 {Math.min(sheet.totalRows, MAX_ROWS)} 行
          {cutCols ? ` × ${MAX_COLS} 列` : ""}。
        </div>
      )}
    </div>
  );
}

/** Escape hatch for anything the in-app renderers cannot show. */
function OpenExternally({ path }: { path: string }) {
  return (
    <button
      onClick={() =>
        void openPath(path).catch((e) => chatStore.pushToast(`打开失败：${errText(e)}`, "error"))
      }
      className="ml-2 rounded border border-edge px-1.5 py-0.5 text-[10px] text-dim hover:text-ink"
    >
      用系统程序打开
    </button>
  );
}
