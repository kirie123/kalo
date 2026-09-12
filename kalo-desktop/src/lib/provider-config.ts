import type { ProviderApi, ProviderCompat, ProviderConfig, ProviderModelDef } from "../types";

/**
 * Local services (Ollama, LM Studio, llama.cpp, …) accept any bearer token.
 * The engine refuses set_model when a provider has no key configured, so an
 * empty key is persisted as this placeholder instead.
 */
export const LOCAL_KEY_PLACEHOLDER = "anonymous";

/** Capability keys the provider-level switches write into every model entry. */
export type CapabilityKey = "reasoning" | "images";

/** Whether every, none, or only some of a provider's models have a capability. */
export type CapabilityState = "all" | "none" | "mixed";

/** One provider's edits as captured by the settings form. */
export interface ProviderFormState {
  name: string;
  api: ProviderApi;
  baseUrl: string;
  apiKey: string;
  /** One model id per line. */
  modelLines: string;
  /** Context window in K tokens; empty means "engine default". */
  contextK: string;
  /** Max output tokens in K; empty means "engine default". */
  maxOutK: string;
  reasoning: boolean;
  images: boolean;
  authHeader: boolean;
  noDeveloperRole: boolean;
  noReasoningEffort: boolean;
}

/**
 * Normalize a provider base URL:
 * - trim whitespace and trailing slashes,
 * - for OpenAI-compatible APIs on a bare localhost host (no path), append
 *   `/v1` — Ollama/LM Studio users usually paste `http://localhost:11434`.
 */
export function normalizeBaseUrl(raw: string, api: ProviderApi): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (api === "openai-completions" || api === "openai-responses") {
    const m = url.match(/^(https?:\/\/[^/]+)$/i);
    if (m && /localhost|127\.0\.0\.1|\[::1\]/i.test(m[1])) url += "/v1";
  }
  return url;
}

/** Model ids listed in the textarea, trimmed, blanks dropped, order kept. */
export function parseModelIds(modelLines: string): string[] {
  return modelLines
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Shared context window (in K tokens) implied by a provider's model list —
 * the modal edits one value for all of the provider's models. Falls back to
 * the engine's own defaults when no model declares one.
 */
export function defaultContextK(id: string, cfg: ProviderConfig): string {
  const w = cfg.models.find((m) => m.contextWindow)?.contextWindow;
  if (w) return String(Math.round(w / 1000));
  // The engine caps Ollama context windows at 128K (num_ctx); larger values
  // would desynchronize compaction from the real server window.
  if (/ollama/i.test(id)) return "128";
  return "200";
}

/** Shared max-output value (in K tokens) implied by the model list, or "" for the engine default. */
export function defaultMaxOutK(cfg: ProviderConfig): string {
  const m = cfg.models.find((model) => model.maxTokens)?.maxTokens;
  return m ? String(Math.round(m / 1000)) : "";
}

/**
 * Whether every, none, or only some models of a provider declare a capability.
 * "mixed" is surfaced in the UI so a hand-edited one-off is not silently kept.
 */
export function readCapability(models: readonly ProviderModelDef[], key: CapabilityKey): CapabilityState {
  if (models.length === 0) return "none";
  const has = (m: ProviderModelDef): boolean =>
    key === "reasoning" ? m.reasoning === true : (m.input ?? []).includes("image");
  const count = models.filter(has).length;
  if (count === 0) return "none";
  return count === models.length ? "all" : "mixed";
}

/** Provider-level bearer switch state: on only when the stored flag is explicitly true. */
export function readAuthHeader(cfg: ProviderConfig | undefined): boolean {
  return cfg?.authHeader === true;
}

function parsePositiveInt(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * Build the provider entry to persist. Unknown/unmanaged fields of the
 * previous entry (`name`, `oauth`, `headers`, `modelOverrides`, …) survive,
 * as do the unmanaged fields of each model (`name`, `cost`, `samplingParams`,
 * …). Only the fields the form owns are overwritten — this is what keeps a
 * hand-edited `authHeader` from being erased by one edit in the UI.
 */
export function buildProviderEntry(
  form: ProviderFormState,
  previous?: ProviderConfig,
): ProviderConfig {
  const compat: ProviderCompat = {};
  if (form.noDeveloperRole) compat.supportsDeveloperRole = false;
  if (form.noReasoningEffort) compat.supportsReasoningEffort = false;

  const prevModels = new Map((previous?.models ?? []).map((m) => [m.id, m] as const));
  const contextWindow = parsePositiveInt(form.contextK);
  const maxTokens = parsePositiveInt(form.maxOutK);

  const models: ProviderModelDef[] = parseModelIds(form.modelLines).map((id) => {
    // Start from the stored entry so display name / cost / sampling survive.
    const def: ProviderModelDef = { ...prevModels.get(id), id };
    def.reasoning = form.reasoning;
    def.input = form.images ? ["text", "image"] : ["text"];
    if (contextWindow !== undefined) def.contextWindow = contextWindow * 1000;
    else delete def.contextWindow;
    if (maxTokens !== undefined) def.maxTokens = maxTokens * 1000;
    else delete def.maxTokens;
    return def;
  });

  const entry: ProviderConfig = {
    ...previous,
    baseUrl: normalizeBaseUrl(form.baseUrl, form.api),
    api: form.api,
    // The engine treats a provider without any key as unauthenticated and
    // refuses set_model, so always persist one; local services ignore it.
    apiKey: form.apiKey.trim() || LOCAL_KEY_PLACEHOLDER,
    models,
  };
  if (Object.keys(compat).length > 0) entry.compat = compat;
  else delete entry.compat;
  if (form.authHeader) entry.authHeader = true;
  else delete entry.authHeader;
  return entry;
}

/** The stored entry to merge from: the target id, or the pre-rename id when renamed. */
export function previousEntryFor(
  providers: Record<string, ProviderConfig>,
  target: string,
  previousId?: string,
): ProviderConfig | undefined {
  return providers[target] ?? (previousId !== undefined ? providers[previousId] : undefined);
}

/** Apply one provider entry to a models.json object, with rename support. */
export function applyProviderEntry(
  providers: Record<string, ProviderConfig>,
  name: string,
  entry: ProviderConfig,
  previousId?: string,
): Record<string, ProviderConfig> {
  const next = { ...providers };
  if (previousId !== undefined && previousId !== name) delete next[previousId];
  next[name] = entry;
  return next;
}
