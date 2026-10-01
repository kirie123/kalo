import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { highlight } from "../lib/highlight";
import { htmlToMarkdown } from "../lib/html-downgrade";
import { splitSvgSegments } from "../lib/svg-render";
import CopyButton from "./CopyButton";
import SvgBlock from "./SvgBlock";

/**
 * Markdown rendering primitives, extracted from AssistantMessage so the
 * streaming throttler (`StreamingText`) can use them without a cycle.
 */

/** Code renderer: inline code vs fenced block (highlight.js for blocks). */
export function CodeRenderer({ className, children }: { className?: string; children?: ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
  const isInline = !lang && !code.includes("\n");
  if (isInline) return <code className="md-inline-code">{code}</code>;

  // ```svg draws the figure; the source stays one toggle away.
  if (lang === "svg") return <SvgBlock source={code} />;

  const html = highlight(code, lang);
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span className="md-codeblock-lang">{lang ?? ""}</span>
        <CopyButton text={code} title="复制代码" />
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/**
 * One markdown text block, memoized on its source text: while the last block
 * of a streaming message grows, the earlier (finished) blocks skip remark/
 * rehype parsing entirely.
 *
 * Inline `<svg>…</svg>` spans are carved out first and drawn as figures, and
 * whitelisted HTML (`<h3>`, `<br>`, `<table>`…) is rewritten as markdown. We
 * deliberately do not enable rehype-raw: no raw HTML is ever executed
 * (doc/2026-09-12-对话区svg渲染.md).
 *
 * Exported because the file preview renders markdown files through the same
 * pipeline — a `.md` file and the agent's prose should look identical.
 */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const segments = splitSvgSegments(text);
  return (
    <div className="markdown">
      {segments.map((segment, i) =>
        segment.type === "svg" ? (
          <SvgBlock key={i} source={segment.source} complete={segment.complete} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              code: CodeRenderer as any,
              // CodeRenderer renders its own <pre>; avoid a double wrapper.
              pre: ({ children }) => <>{children}</>,
            }}
          >
            {htmlToMarkdown(segment.text)}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
});