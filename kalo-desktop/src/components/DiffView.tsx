import { useLayoutEffect, useRef, useState } from "react";
import type { ToolResultMessage } from "../types";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "skip";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/**
 * Parse the display diff produced by the engine's edit tool
 * (details.diff). Line format: <sign><padded line number> <content>,
 * where sign is "+", "-" or " " (context); skipped ranges are a line
 * whose content is "..." with no number.
 */
export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    const m = raw.match(/^([+\- ])(\s*\d+)? (.*)$/);
    if (!m) {
      if (raw.trim()) lines.push({ kind: "ctx", text: raw });
      continue;
    }
    const [, sign, numStr, text] = m;
    const num = numStr ? parseInt(numStr, 10) : undefined;
    if (sign === " " && num === undefined && text.trim() === "...") {
      lines.push({ kind: "skip", text: "..." });
    } else if (sign === "+") {
      lines.push({ kind: "add", newNo: num, text });
    } else if (sign === "-") {
      lines.push({ kind: "del", oldNo: num, text });
    } else {
      lines.push({ kind: "ctx", oldNo: num, newNo: num, text });
    }
  }
  return lines;
}

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+")) add++;
    else if (l.startsWith("-")) del++;
  }
  return { add, del };
}

/** Extract the unified-style diff from an edit tool result, if present. */
export function extractDiff(result: any): string | undefined {
  const diff = result?.details?.diff;
  return typeof diff === "string" ? diff : undefined;
}

/** Best-effort text extraction from a tool result / partial result. */
export function resultText(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = result.content as ToolResultMessage["content"] | undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Collapsed height cap (px) when `collapsible` is on — roughly 12 diff rows. */
const COLLAPSED_MAX_H = 240;

export default function DiffView({
  diff,
  lines: preparsed,
  collapsible = false,
}: {
  /** Engine display-diff text. Ignored when `lines` is given. */
  diff?: string;
  /**
   * Already-parsed lines, for callers whose source is not the engine's display
   * format (the file panel's `git diff` output, parsed by `lib/git.ts`).
   */
  lines?: DiffLine[];
  collapsible?: boolean;
}) {
  const lines = preparsed ?? parseDiff(diff ?? "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Diffs stream in while the edit is running, so re-measure on content resize
  // rather than only on mount.
  useLayoutEffect(() => {
    if (!collapsible) return;
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSED_MAX_H + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsible, diff, preparsed]);

  const clamped = collapsible && overflowing && !expanded;

  return (
    <div className="relative overflow-hidden rounded-md border border-edge">
      <div
        ref={bodyRef}
        className="overflow-x-auto"
        style={clamped ? { maxHeight: COLLAPSED_MAX_H, overflowY: "hidden" } : undefined}
      >
        <table className="mono w-full border-collapse text-xs leading-5">
          <tbody>
            {lines.map((line, i) => {
              const rowBg =
                line.kind === "add"
                  ? "bg-[var(--diff-add-bg)]"
                  : line.kind === "del"
                    ? "bg-[var(--diff-del-bg)]"
                    : "";
              const textColor =
                line.kind === "add"
                  ? "text-[var(--diff-add-text)]"
                  : line.kind === "del"
                    ? "text-[var(--diff-del-text)]"
                    : "";
              if (line.kind === "skip") {
                return (
                  <tr key={i}>
                    <td colSpan={3} className="px-2 text-center text-dim">
                      ⋮
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={i} className={rowBg}>
                  <td className="w-10 select-none px-2 text-right text-dim">{line.oldNo ?? ""}</td>
                  <td className="w-10 select-none px-2 text-right text-dim">{line.newNo ?? ""}</td>
                  <td className={`whitespace-pre px-2 ${textColor}`}>
                    <span className="mr-2 select-none">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                    </span>
                    {line.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {collapsible && overflowing && (
        clamped ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-20 items-end justify-end bg-gradient-to-b from-transparent to-[var(--bg)] px-2 pb-2">
            <button
              onClick={() => setExpanded(true)}
              className="pointer-events-auto rounded-md border border-edge bg-card px-2 py-1 text-[11px] text-dim shadow-sm hover:text-ink"
            >
              点击展开（共 {lines.length} 行）
            </button>
          </div>
        ) : (
          <div className="flex justify-end border-t border-edge px-2 py-1">
            <button
              onClick={() => setExpanded(false)}
              className="rounded-md border border-edge bg-card px-2 py-1 text-[11px] text-dim hover:text-ink"
            >
              收起
            </button>
          </div>
        )
      )}
    </div>
  );
}
