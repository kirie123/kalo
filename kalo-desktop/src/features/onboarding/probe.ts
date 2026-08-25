/**
 * The two things the model step needs a live engine for: what models are
 * actually available, and whether the configured one answers.
 *
 * Both run the real path instead of describing it — same principle as
 * `MarketEnvCard`, where what is shown must be something that was executed.
 * A throwaway engine session is the mechanism, because the engine reads
 * models.json / auth.json when its process starts, so a freshly spawned one
 * always sees what the form just saved. Three routes were rejected:
 *
 *   - an HTTP call from Rust — there is no HTTP client on the Rust side, and
 *     one test button does not justify pulling one in;
 *   - `fetch` from the webview — cross-origin, blocked;
 *   - hand-rolling each provider's request body, and hard-coding a model list
 *     per provider — that is re-implementing `packages/ai` in the UI layer,
 *     where it would quietly drift from what the engine really sends and
 *     really offers, which is the one thing these two calls must not do.
 *
 * Note the event listener also calls `resolveResponse`: the chat store routes
 * responses for *its* sessions, and these sessions are deliberately not among
 * them, so nothing else would ever settle `sendCommand`'s promises.
 */

import {
  appPaths,
  closeSession,
  createSession,
  deleteSession,
  onPiEvent,
  onPiExit,
  resolveResponse,
  sendCommand,
} from "../../lib/pi-bridge";
import { formatApiError } from "../../lib/error-format";
import type { ModelInfo, PiEvent, RpcResponse, RpcSessionState } from "../../types";

export interface ProbeResult {
  ok: boolean;
  /** One line, safe to show as-is. */
  summary: string;
  /** Raw provider/engine text, when there is more than the summary. */
  detail?: string;
}

/** Whole-probe budget. A cold engine plus a slow provider is a few seconds. */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Turn an engine or provider error into something a person can act on.
 *
 * Pure on purpose — it is the only part of this file that can be tested
 * without a real process and a real network, so it is where the knowledge of
 * "what does this failure mean" is kept.
 */
export function explainProbeError(raw: string): ProbeResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, summary: "测试失败，但引擎没有给出原因" };

  // Engine-side refusals, before any request leaves the machine. These two
  // strings come from rpc-mode's set_model and from packages/ai's key lookup.
  if (/^Model not found/i.test(text)) {
    return {
      ok: false,
      summary: "引擎未识别该模型。检查模型 ID 是否拼对；若刚添加 Provider，回去编辑保存一次再试",
      detail: text,
    };
  }
  if (/No API key/i.test(text)) {
    return {
      ok: false,
      summary: "该 Provider 没有配置 API Key。本地服务（Ollama 等）也需要填一个任意占位 Key",
      detail: text,
    };
  }

  // Transport-level: the request never reached a provider that could answer.
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network error/i.test(text)) {
    return {
      ok: false,
      summary: "连不上服务地址。检查 Base URL 是否写对、本地服务有没有起来、要不要走代理",
      detail: text,
    };
  }

  const parsed = formatApiError(text);
  const hint = statusHint(parsed.status);
  return {
    ok: false,
    summary: hint ? `${parsed.summary}（${hint}）` : parsed.summary,
    detail: parsed.detail ?? text,
  };
}

/** What the common provider status codes usually mean here. */
function statusHint(status?: number): string | undefined {
  switch (status) {
    case 401:
    case 403:
      return "Key 无效或没有这个模型的权限";
    case 402:
      return "账户余额不足";
    case 404:
      return "模型 ID 或 Base URL 不对";
    case 429:
      return "被限流，稍后再试";
    default:
      return status && status >= 500 ? "服务端故障，稍后再试" : undefined;
  }
}

// ============================================================================
// The two public calls
// ============================================================================

/**
 * Every model the engine would offer right now, built-in providers included.
 *
 * Costs an engine spawn and zero tokens. The desktop side has no catalog of
 * its own on purpose: model IDs move with the engine version, and a list that
 * silently goes stale is worse than a two-second wait.
 */
export async function listEngineModels(): Promise<ModelInfo[]> {
  return withEngineSession(async ({ sid }) => {
    const resp = await sendCommand(sid, { type: "get_available_models" }, 15_000);
    if (!resp.success) return [];
    return (resp.data as { models?: ModelInfo[] })?.models ?? [];
  }).catch(() => []);
}

/**
 * Ask the model for two characters and report what came back.
 *
 * Never rejects — every outcome is a `ProbeResult`, because the caller renders
 * failures rather than handling them.
 */
export async function probeModel(provider: string, modelId: string): Promise<ProbeResult> {
  try {
    return await withEngineSession(async ({ sid, verdict, finish }) => {
      const setModel = await sendCommand(sid, { type: "set_model", provider, modelId }, 15_000);
      if (!setModel.success) return explainProbeError(setModel.error);

      // Auto-retry is the right default for a real conversation and the wrong
      // one here: a bad key would sit through exponential backoff before
      // admitting it, and someone is watching a button spin. Fail on the
      // first answer.
      await sendCommand(sid, { type: "set_auto_retry", enabled: false }, 5_000).catch(() => {});

      const prompt = await sendCommand(sid, { type: "prompt", message: "只回复两个字：OK" }, 30_000);
      // A prompt that fails preflight (unusable model, missing credentials)
      // reports here rather than as an event.
      if (!prompt.success) return explainProbeError(prompt.error);

      return Promise.race([
        verdict,
        sleep(PROBE_TIMEOUT_MS).then(() => {
          finish({ ok: false, summary: `等待模型回复超过 ${PROBE_TIMEOUT_MS / 1000} 秒，已放弃` });
          return verdict;
        }),
      ]);
    });
  } catch (err) {
    return explainProbeError(err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// Throwaway session
// ============================================================================

interface EngineSession {
  sid: string;
  /** Settles when a run event decides the outcome. */
  verdict: Promise<ProbeResult>;
  /** First call wins, so an error verdict beats the settled-normally one. */
  finish: (r: ProbeResult) => void;
}

/**
 * Spawn an engine, run `fn`, and leave nothing behind — a "只回复两个字：OK"
 * row in the sidebar would be worse than having no test button at all.
 */
async function withEngineSession<T>(fn: (s: EngineSession) => Promise<T>): Promise<T> {
  const cleanups: Array<() => void> = [];
  let sid: string | null = null;
  let sessionFile: string | undefined;

  let settle: ((r: ProbeResult) => void) | null = null;
  const verdict = new Promise<ProbeResult>((resolve) => {
    settle = resolve;
  });
  const finish = (r: ProbeResult) => {
    settle?.(r);
    settle = null;
  };

  try {
    const paths = await appPaths();
    sid = await createSession(paths.kaloRoot || paths.home || ".");
    const activeSid = sid;

    cleanups.push(
      await onPiEvent(activeSid, (payload) => {
        if (!payload || typeof payload !== "object") return;
        if ((payload as { type?: string }).type === "response") {
          resolveResponse(payload as RpcResponse);
          return;
        }
        handleProbeEvent(payload as PiEvent, finish);
      }),
    );
    cleanups.push(
      await onPiExit(activeSid, () => {
        finish({ ok: false, summary: "引擎进程意外退出，未能完成测试" });
      }),
    );

    sessionFile = (await waitForEngine(activeSid))?.sessionFile;
    return await fn({ sid: activeSid, verdict, finish });
  } finally {
    // Ask once more while the engine is still alive: a session that never
    // wrote a message may not have had a file at startup.
    if (sid && !sessionFile) {
      const st = await sendCommand(sid, { type: "get_state" }, 5_000).catch(() => null);
      if (st?.success) sessionFile = (st.data as RpcSessionState)?.sessionFile;
    }
    for (const off of cleanups) {
      try {
        off();
      } catch {
        // Unlisten on a torn-down window; nothing to do.
      }
    }
    if (sid) await closeSession(sid).catch(() => {});
    // Best effort: a leftover file is untidy, not broken, and the user has
    // their answer by now.
    if (sessionFile) await deleteSession(sessionFile).catch(() => {});
  }
}

/** Map the engine's run events onto a verdict. */
function handleProbeEvent(ev: PiEvent, finish: (r: ProbeResult) => void) {
  switch (ev.type) {
    case "message_end": {
      const msg = ev.message as { role?: string; stopReason?: string; errorMessage?: string };
      // Provider-side failures (401, 429, overloaded, …) arrive as an assistant
      // message that stopped on "error", not as a failed command response.
      if (msg?.role === "assistant" && msg.stopReason === "error") {
        finish(explainProbeError(msg.errorMessage ?? "模型调用失败"));
      }
      break;
    }
    case "agent_settled":
      // Reached only when no error message preceded it — `finish` is one-shot,
      // so an earlier failure verdict wins.
      finish({ ok: true, summary: "连通正常，模型已回复" });
      break;
    case "extension_error":
      finish({ ok: false, summary: `扩展错误：${ev.error ?? "未知错误"}` });
      break;
    default:
      break;
  }
}

/**
 * Poll `get_state` until the engine's dispatch loop is up — commands sent
 * before then are silently dropped. Same backoff shape as the chat store's
 * `waitForEngine`; duplicated rather than shared because that one is a private
 * method operating on a runtime these throwaway sessions deliberately lack.
 */
async function waitForEngine(sid: string, budgetMs = 20_000): Promise<RpcSessionState | null> {
  const start = Date.now();
  let delay = 250;
  let probeTimeout = 300;
  while (Date.now() - start < budgetMs) {
    try {
      const resp = await sendCommand(sid, { type: "get_state" }, probeTimeout);
      return resp.success ? ((resp.data as RpcSessionState) ?? null) : null;
    } catch {
      // Not ready yet — back off and retry.
    }
    await sleep(delay * (0.75 + Math.random() * 0.5));
    delay = Math.min(delay * 2, 2000);
    probeTimeout = Math.min(probeTimeout * 2, 2000);
  }
  throw new Error("引擎无响应");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
