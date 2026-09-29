/**
 * Types and helpers for the show_widget tool's frontend contract.
 *
 * Mirrors kalo-harness/packages/coding-agent/src/extensions/show-widget/index.ts
 * WidgetDetails rides AgentToolResult.details into session jsonl for replay.
 */

export type RenderMode = "svg" | "html";

export interface WidgetDetails {
  type: "widget";
  title: string;
  widget_code: string;
  loading_messages: string[];
  render_mode: RenderMode;
}

export interface WidgetSummary {
  title: string;
  widget_code: string;
  loading_messages: string[];
  render_mode: RenderMode;
}

function isWidgetDetails(v: unknown): v is WidgetDetails {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    d.type === "widget" &&
    typeof d.title === "string" &&
    typeof d.widget_code === "string" &&
    Array.isArray(d.loading_messages) &&
    (d.render_mode === "svg" || d.render_mode === "html")
  );
}

/**
 * Extract a WidgetSummary from a show_widget tool call record.
 * Returns null when the record is not a valid show_widget result.
 */
export function parseWidget(rec: {
  toolName: string;
  status: string;
  result?: { details?: unknown };
}): WidgetSummary | null {
  if (rec.toolName !== "show_widget" || rec.status === "error") return null;
  const details = rec.result?.details;
  if (!isWidgetDetails(details)) return null;
  return {
    title: details.title,
    widget_code: details.widget_code,
    loading_messages: details.loading_messages,
    render_mode: details.render_mode,
  };
}
