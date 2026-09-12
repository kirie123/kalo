/**
 * Turn raw engine/provider error strings into a clean one-line summary,
 * keeping the raw text available as expandable detail.
 *
 * Handles shapes like:
 *   OpenAI API error (429): {"code":"ServerOverloaded","message":"...","type":"TooManyRequests"}
 *   529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 */
export interface ParsedError {
  summary: string;
  detail?: string;
  status?: number;
}

/**
 * Is this "error" really the user pressing stop?
 *
 * `stopReason: "aborted"` only covers aborts that land while the model is
 * streaming. Abort a turn while a tool is running and the engine settles it as
 * a plain error whose message is the AbortError text ("The operation was
 * aborted") — same user action, different shape. Neither should show up as a
 * red crash block (doc/2026-09-10-打断提示波浪分割线.md).
 *
 * Matched on the message rather than an error code because the string is what
 * crosses the sidecar boundary. Kept to whole-message equality so a provider
 * payload that merely mentions aborting is still reported as a failure.
 */
export function isAbortError(raw: string | undefined): boolean {
  if (!raw) return false;
  const core = raw
    .trim()
    // Leading "AbortError:" / "Error:" prefixes, and a trailing period.
    .replace(/^(?:[A-Za-z]*Error)\s*:\s*/i, "")
    .replace(/\.\s*$/, "")
    .trim()
    .toLowerCase();
  return (
    core === "aborted" ||
    core === "operation was aborted" ||
    core === "the operation was aborted" ||
    core === "this operation was aborted" ||
    core === "request was aborted"
  );
}

/** Drop the noisy trailing "Request id: xxx" from provider messages. */
function cleanMessage(msg: string): string {
  return msg.replace(/\s*Request id:\s*\S+\s*$/i, "").trim();
}

function innerMessage(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const nested = o.error as Record<string, unknown> | undefined;
  const msg = nested?.message ?? o.message;
  return typeof msg === "string" && msg ? cleanMessage(msg) : undefined;
}

export function formatApiError(raw: string): ParsedError {
  const text = raw.trim();

  // "<Label> (<status>): <json>"
  const labeled = text.match(/^([^{]+?)\s*\((\d{3})\)\s*:\s*(\{[\s\S]*\})\s*$/);
  if (labeled) {
    const [, label, status, jsonStr] = labeled;
    try {
      const msg = innerMessage(JSON.parse(jsonStr));
      if (msg) return { summary: `${label.trim()} (${status})：${msg}`, detail: text, status: Number(status) };
    } catch {
      // fall through to generic handling
    }
  }

  // "<status> <json>"
  const bare = text.match(/^(\d{3})\s+(\{[\s\S]*\})$/);
  if (bare) {
    const [, status, jsonStr] = bare;
    try {
      const msg = innerMessage(JSON.parse(jsonStr));
      if (msg) return { summary: `HTTP ${status}：${msg}`, detail: text, status: Number(status) };
    } catch {
      // fall through
    }
  }

  // Fallback: first line, truncated.
  const first = text.split("\n")[0];
  const summary = first.length > 160 ? `${first.slice(0, 160)}…` : first;
  return { summary, detail: text.length > summary.length ? text : undefined };
}
