/**
 * Web fetch extension — gives the model a web_fetch tool for online research.
 *
 * Fetches a URL and returns its text content: HTML pages are converted to a
 * plain-text approximation (block tags become newlines, scripts/styles
 * dropped, common entities decoded); other text types are returned as-is.
 * No new dependencies, no API keys.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const FETCH_TIMEOUT_MS = 20_000;
/** Stop reading the body past this many bytes. */
const MAX_BODY_BYTES = 2_000_000;
/** Default/max characters returned to the model. */
const DEFAULT_MAX_CHARS = 8000;
const HARD_MAX_CHARS = 40_000;

/** Crude HTML to text: enough for article/paper pages, not a renderer. */
function htmlToText(html: string): string {
	let text = html;
	// Drop non-content blocks entirely.
	text = text.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "");
	// Block-level tags and breaks become newlines; list items get a marker.
	text = text.replace(/<li[\s>]/gi, "\n- ");
	text = text.replace(
		/<(br|p|div|section|article|header|footer|h[1-6]|tr|table|ul|ol|blockquote|pre|hr)[\s/>]/gi,
		"\n",
	);
	// Strip everything else.
	text = text.replace(/<[^>]+>/g, "");
	// Decode the common entities.
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
	// Collapse whitespace runs and blank lines.
	text = text.replace(/[^\S\n]+/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function webFetchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its text content. HTML pages are converted to plain text. " +
			"Use for online research: arXiv abstract pages, ar5iv full texts, blogs, documentation.",
		promptSnippet: "web_fetch(url, maxChars?) — 抓取网页并返回正文文本",
		promptGuidelines: [
			"在线调研时用 web_fetch 读取网页正文；arXiv 论文优先抓 https://ar5iv.org/abs/<id> 全文，其次 https://arxiv.org/abs/<id> 摘要页",
			"web_fetch 返回的是去标签纯文本，图片/表格结构会丢失；需要精确定位时可分段增大 maxChars 重抓",
		],
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL" }),
			maxChars: Type.Optional(Type.Number({ description: `返回正文的最大字符数，默认 ${DEFAULT_MAX_CHARS}` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const url = params.url.trim();
			if (!/^https?:\/\//i.test(url)) {
				return {
					content: [{ type: "text", text: `无效 URL：${url}（仅支持 http/https）` }],
					details: { error: "invalid url" },
				};
			}
			const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_MAX_CHARS, 500), HARD_MAX_CHARS);
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
				let resp: Response;
				try {
					resp = await fetch(url, {
						signal: controller.signal,
						redirect: "follow",
						headers: {
							"user-agent": "Mozilla/5.0 (compatible; kalo-research)",
							accept: "text/html,text/plain,application/json,*/*",
						},
					});
				} finally {
					clearTimeout(timer);
				}
				if (!resp.ok) {
					return {
						content: [{ type: "text", text: `抓取失败：HTTP ${resp.status}（${url}）` }],
						details: { error: `http ${resp.status}` },
					};
				}
				// Read the body with a byte cap.
				const reader = resp.body?.getReader();
				if (!reader) {
					return { content: [{ type: "text", text: "抓取失败：响应无内容" }], details: { error: "empty body" } };
				}
				const chunks: Uint8Array[] = [];
				let received = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
					received += value.length;
					if (received >= MAX_BODY_BYTES) {
						await reader.cancel();
						break;
					}
				}
				const raw = new TextDecoder().decode(
					chunks.reduce((acc, c) => {
						const merged = new Uint8Array(acc.length + c.length);
						merged.set(acc);
						merged.set(c, acc.length);
						return merged;
					}, new Uint8Array(0)),
				);
				const contentType = resp.headers.get("content-type") ?? "";
				const text = contentType.includes("html") ? htmlToText(raw) : raw.trim();
				const truncated = text.length > maxChars;
				const body = truncated ? `${text.slice(0, maxChars)}\n\n…（已截断，可用更大的 maxChars 重抓）` : text;
				return {
					content: [{ type: "text", text: `# ${url}\n\n${body}` }],
					details: { url, status: resp.status, truncated, totalChars: text.length },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `抓取失败：${errText(err)}（${url}）` }],
					details: { error: errText(err) },
				};
			}
		},
	});
}
