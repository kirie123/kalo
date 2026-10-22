/**
 * show-widget extension — lets the model render inline SVG/HTML visualizations.
 *
 * Two tools:
 *   read_me(modules)               — pulls design guidelines on demand
 *   show_widget(title, widget_code, loading_messages) — declares a widget
 *
 * The widget rides AgentToolResult.details as WidgetDetails, landing in the
 * session jsonl for history replay. The desktop renders it in a sandboxed
 * iframe. P1 supports raw SVG; P2 adds HTML+JS with the three-phase streaming
 * renderer.
 *
 * Design: doc/2026-09-28-产物呈现通道.md (show_widget section)
 */

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const UNATTENDED_ENV = "KALO_UNATTENDED";

// ---------------------------------------------------------------------------
// Wire types (mirrored in kalo-desktop/src/lib/widgets.ts)
// ---------------------------------------------------------------------------

export type RenderMode = "svg" | "html";

export interface WidgetDetails {
	type: "widget";
	title: string;
	widget_code: string;
	loading_messages: string[];
	render_mode: RenderMode;
}

// ---------------------------------------------------------------------------
// Design guidelines (returned by read_me, never in system prompt)
// ---------------------------------------------------------------------------

const VALID_MODULES = ["diagram", "mockup", "interactive", "chart", "art"] as const;
type Module = (typeof VALID_MODULES)[number];

const CDN_ALLOWLIST = ["cdnjs.cloudflare.com", "esm.sh", "cdn.jsdelivr.net", "unpkg.com"];

function getCoreDesignSystem(): string {
	return `# Core Design System
Use the CSS variables injected by the host (prefixed --cb-). Key tokens:
  --cb-panel-bg-primary   page/iframe background
  --cb-text-primary       body text
  --cb-text-secondary     muted / dim text
  --cb-border-default     border colour
  --cb-accent-primary     primary accent (buttons, highlights)

RULES:
- No top-level padding on #root — the host controls outer spacing.
- Use relative units (em, rem, %) for font sizes; never px font sizes.
- No position:fixed — iframe height auto-sizes from in-flow content.
- No <form> tags — use normal controls + event handlers.
- No localStorage/sessionStorage — opaque origin blocks them (SecurityError).
CDN allowlist (CSP-enforced): ${CDN_ALLOWLIST.join(", ")}
CSP blocks raw.githubusercontent.com and other unlisted domains.
Host rewrites local file paths to loadable form — do NOT hand-write data: base64.`;
}

function getColorPalette(): string {
	return `# Color Palette
Use --cb-* variables. For charts/diagrams when you need explicit hues:
Sequential: use one hue with lightness steps (oklch).
Diverging: only across a meaningful midpoint.
Categorical: cap at ~6; ensure distinguishable lightness, not just hue.
Never encode state with hue alone — pair with icon, weight, or label.`;
}

function getSvgSetup(): string {
	return `# SVG Setup
- viewBox must be "0 0 680 <height>" — width is always 680.
- Exactly one <svg> element, no <html>/<head>/<body> wrapper.
- Use <text> for labels; set font-family to inherit or a system stack.
- Accessible: <title> inside the <svg> for screen readers.`;
}

function getChartRules(): string {
	return `# Chart Rules (Chart.js / ECharts from CDN)
Load from: https://cdn.jsdelivr.net/npm/chart.js or https://cdn.jsdelivr.net/npm/echarts
Canvas-based charts: the host handles dispose on finalize — do not cache the
instance yourself across re-renders.
Always set responsive:true and maintainAspectRatio:false on Chart.js.
ECharts: call echarts.init(dom) inside the script; the host disposes and
rebuilds on finalize. Do not call init twice without dispose.`;
}

function getDiagramTypes(): string {
	return `# Diagram Types
Flowchart: boxes (rect/roundrect) + arrows, left-to-right or top-down.
Sequence: vertical timelines, horizontal messages.
Tree/hierarchy: parent-child lines, consistent spacing.
All in SVG (viewBox 0 0 680 <h>). Labels in <text>; group related items with <g>.`;
}

function getUIComponents(): string {
	return `# UI Components (HTML widgets)
Prefer semantic HTML. Use CSS variables for color. Keep all JS inline in <script> tags.
Interactive controls: <button>, <input>, <select>, <textarea> — not <form>.
For tabs/panels: use buttons + hidden divs, toggled with JS.
For data tables: <table> with sticky <thead>, aligned numbers, readable row height.`;
}

function buildGuidelines(modules: Module[]): string {
	const sections: string[] = [getCoreDesignSystem(), getColorPalette()];
	const hasSvg = modules.some((m) => m === "diagram" || m === "art");
	const hasHtml = modules.some((m) => m === "mockup" || m === "interactive" || m === "chart");
	if (hasSvg) sections.push(getSvgSetup());
	if (hasHtml) sections.push(getUIComponents());
	for (const mod of modules) {
		if (mod === "diagram") sections.push(getDiagramTypes());
		if (mod === "chart") sections.push(getChartRules());
	}
	return sections.join("\n\n");
}

function parseModules(raw: unknown): Module[] {
	let list: string[] = [];
	if (Array.isArray(raw)) {
		list = raw.map(String);
	} else if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) list = parsed.map(String);
			else list = raw.split(/[\s,]+/);
		} catch {
			list = raw.split(/[\s,]+/);
		}
	}
	return list.map((s) => s.trim().toLowerCase()).filter((s): s is Module => VALID_MODULES.includes(s as Module));
}

// ---------------------------------------------------------------------------
// Validation (mirrors WorkBuddy validateInputs)
// ---------------------------------------------------------------------------

function validateWidget(widgetCode: string, loadingMessages: string[], title: string): string | null {
	if (!title.trim()) return "title is required.";
	if (!widgetCode.trim()) return "widget_code is required.";
	if (loadingMessages.length === 0) return "loading_messages must contain at least one message.";
	if (loadingMessages.length > 4) return "loading_messages can contain at most four messages.";
	const code = widgetCode.trim();
	if (/<(!DOCTYPE|html|head|body)\b/i.test(code))
		return "widget_code must be a raw SVG or HTML fragment without document wrapper tags (<html>/<head>/<body>/<!DOCTYPE>).";
	if (/\b(localStorage|sessionStorage)\b/.test(code))
		return "widget_code cannot use localStorage or sessionStorage — the sandbox runs in an opaque origin where those APIs throw SecurityError.";
	if (/position\s*:\s*fixed/i.test(code))
		return "widget_code cannot use position: fixed because the widget height is auto-sized from in-flow content.";
	if (/<form[\s>]/i.test(code))
		return "widget_code cannot use <form> tags. Use normal controls and event handlers instead.";
	if (code.startsWith("<svg")) {
		if ((code.match(/<svg[\s>]/gi) ?? []).length !== 1) return "widget_code must contain exactly one <svg> element.";
		if (!/viewBox\s*=\s*["']0\s+0\s+680\s+\d+["']/i.test(code))
			return 'SVG widget_code must use a viewBox starting with "0 0 680 " (width is always 680).';
	}
	return null;
}

function parseLoadingMessages(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
			} catch {}
		}
		return trimmed
			.replace(/^\[/, "")
			.replace(/\]$/, "")
			.split(/[\n,，]/)
			.map((s) =>
				s
					.replace(/^["'""'']+/, "")
					.replace(/["'""'']+$/, "")
					.trim(),
			)
			.filter(Boolean);
	}
	return [];
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function showWidgetExtension(api: ExtensionAPI) {
	if (process.env[UNATTENDED_ENV] === "1") return;

	// --- read_me ---
	api.registerTool({
		name: "read_me",
		label: "读取设计规范",
		description:
			"Returns required context for show_widget (CSS variables, colors, typography, " +
			"layout rules, examples). Call before your first show_widget call in a turn. " +
			"Call again later if you need a different module. " +
			"Do NOT mention or narrate this call to the user — it is an internal setup step.",
		parameters: Type.Object({
			modules: Type.Union([Type.Array(Type.String()), Type.String()], {
				description: `Which module(s) to load. Pick all that fit. Options: ${VALID_MODULES.join(", ")}. Pass as an array, a JSON-encoded string array, or a comma-separated list like "diagram,chart".`,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const mods = parseModules((params as Record<string, unknown>).modules);
			const content = buildGuidelines(mods.length > 0 ? mods : ["diagram"]);
			return {
				content: [{ type: "text" as const, text: content }],
				details: null,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("dim", "读取 show_widget 设计规范"), 0, 0);
		},
		renderResult(_result, _opts, theme) {
			return new Text(theme.fg("dim", "设计规范已加载"), 0, 0);
		},
	});

	// --- show_widget ---
	api.registerTool({
		name: "show_widget",
		label: "渲染可视化",
		description:
			"Show visual content — SVG graphics, diagrams, charts, or interactive HTML " +
			"widgets — that renders inline alongside your text response. " +
			"Call read_me (modules: diagram|mockup|interactive|chart|art) before your first " +
			"show_widget call to load required design guidance. " +
			"widget_code MUST be a raw SVG/HTML fragment (no <html>/<head>/<body>/<!DOCTYPE>); " +
			'for SVG use a viewBox starting with "0 0 680 ".',
		parameters: Type.Object({
			title: Type.String({
				description:
					"Short identifier for this visual, in the same language the user is using. " +
					"Must be specific — if the conversation has multiple visuals, this title alone " +
					"should tell which one is being referenced. Used as the download filename.",
			}),
			widget_code: Type.String({
				description:
					"SVG or HTML code to render. For SVG: raw code starting with <svg> tag. " +
					"For HTML: raw HTML fragment, do NOT include DOCTYPE, <html>, <head>, or <body> tags.",
			}),
			loading_messages: Type.String({
				description:
					"A JSON-encoded string array of 1–4 loading messages shown while the visual renders, " +
					"each roughly 5 words long. Write in the same language the user is using. " +
					'Example: \'["Preparing chart data","Rendering visualization","Applying styles","Almost ready"]\'',
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as Record<string, unknown>;
			const title = String(p.title ?? "").trim();
			const widget_code = String(p.widget_code ?? "").trim();
			const loading_messages = parseLoadingMessages(p.loading_messages);

			const err = validateWidget(widget_code, loading_messages, title);
			if (err) throw new Error(`show_widget: ${err}`);

			const sanitizedTitle =
				title
					.replace(/[\s-]+/g, "_")
					.replace(/[^\p{L}\p{N}_]/gu, "")
					.replace(/^_+|_+$/g, "")
					.replace(/_{2,}/g, "_") || "widget";

			const render_mode: RenderMode = widget_code.startsWith("<svg") ? "svg" : "html";

			const details: WidgetDetails = {
				type: "widget",
				title: sanitizedTitle,
				widget_code,
				loading_messages,
				render_mode,
			};

			return {
				content: [{ type: "text" as const, text: "Widget payload prepared for inline rendering." }],
				details,
			};
		},
		renderCall(args, theme) {
			const title = String((args as Record<string, unknown>).title ?? "");
			return new Text(theme.fg("toolTitle", theme.bold("widget ")) + theme.fg("muted", title || "…"), 0, 0);
		},
		renderResult(_result, _opts, theme) {
			return new Text(theme.fg("dim", "可视化已准备好"), 0, 0);
		},
		promptSnippet: `- \`show_widget\`: renders inline SVG or HTML visualizations. Always call \`read_me\` first.`,
		promptGuidelines: [
			"先调用 read_me 加载设计规范（modules: diagram/chart/mockup/interactive/art），再调用 show_widget",
			"widget_code 必须是裸 SVG 或 HTML 片段：无 <html>/<head>/<body>/<!DOCTYPE>",
			'SVG 的 viewBox 必须是 "0 0 680 <height>"，且只有一个 <svg> 元素',
			"不能用 localStorage/sessionStorage / position:fixed / <form>",
			"loading_messages：1–4 条，每条约 5 词，与用户语言一致，JSON 数组字符串",
		],
	});
}
