import { useState } from "react";
import { chatStore } from "../lib/chat-store";
import { readModelsConfig, writeModelsConfig } from "../lib/pi-bridge";
import type { ProviderApi, ProviderConfig } from "../types";

const API_OPTIONS: Array<{ value: ProviderApi; label: string }> = [
  { value: "openai-completions", label: "OpenAI Completions（/v1/chat/completions）" },
  { value: "openai-responses", label: "OpenAI Responses（/v1/responses）" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

export interface ProviderEditTarget {
  /** Existing provider id when editing; undefined for a new provider. */
  id?: string;
  config: ProviderConfig;
}

/**
 * Local services (Ollama, LM Studio, llama.cpp, …) accept any bearer token.
 * The engine refuses set_model when a provider has no key configured, so an
 * empty key is persisted as this placeholder instead.
 */
const LOCAL_KEY_PLACEHOLDER = "anonymous";

/**
 * Normalize a provider base URL:
 * - trim whitespace and trailing slashes,
 * - for OpenAI-compatible APIs on a bare localhost host (no path), append
 *   `/v1` — Ollama/LM Studio users usually paste `http://localhost:11434`.
 */
function normalizeBaseUrl(raw: string, api: ProviderApi): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (api === "openai-completions" || api === "openai-responses") {
    const m = url.match(/^(https?:\/\/[^/]+)$/i);
    if (m && /localhost|127\.0\.0\.1|\[::1\]/i.test(m[1])) url += "/v1";
  }
  return url;
}

/** Quick-fill presets for common local model services. */
const PRESETS: Array<{ label: string; apply: () => Partial<Record<string, string>> }> = [
  {
    label: "Ollama",
    apply: () => ({
      name: "ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      apiKey: LOCAL_KEY_PLACEHOLDER,
    }),
  },
  {
    label: "LM Studio",
    apply: () => ({
      name: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://localhost:1234/v1",
      apiKey: LOCAL_KEY_PLACEHOLDER,
    }),
  },
];

interface Props {
  /** Pre-filled values when editing an existing provider. */
  editing?: ProviderEditTarget;
  onClose: (saved: boolean) => void;
}

/**
 * Config panel for one custom provider (written to ~/.kalo/agent/models.json).
 * Opened from the model picker's "添加模型" entry and from the settings page.
 */
export default function ProviderEditModal({ editing, onClose }: Props) {
  const [name, setName] = useState(editing?.id ?? "");
  const [api, setApi] = useState<ProviderApi>(editing?.config.api ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(editing?.config.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(editing?.config.apiKey ?? "");
  const [modelLines, setModelLines] = useState(
    (editing?.config.models ?? []).map((m) => m.id).join("\n"),
  );
  // Shared context window for all models of this provider, in K tokens.
  const [contextK, setContextK] = useState(() => {
    const w = editing?.config.models.find((m) => m.contextWindow)?.contextWindow;
    return w ? String(Math.round(w / 1000)) : "200";
  });
  const [noDeveloperRole, setNoDeveloperRole] = useState(
    editing?.config.compat?.supportsDeveloperRole === false,
  );
  const [noReasoningEffort, setNoReasoningEffort] = useState(
    editing?.config.compat?.supportsReasoningEffort === false,
  );
  const [saving, setSaving] = useState(false);

  const isEdit = editing?.id !== undefined;
  const valid =
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    modelLines.split("\n").some((l) => l.trim() !== "");

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const modelsConfig = await readModelsConfig();
      const providers = { ...(modelsConfig.providers ?? {}) };

      // Renaming removes the old entry.
      const editId = editing?.id;
      if (editId !== undefined && editId !== name.trim()) delete providers[editId];

      const compat: ProviderConfig["compat"] = {};
      if (noDeveloperRole) compat.supportsDeveloperRole = false;
      if (noReasoningEffort) compat.supportsReasoningEffort = false;

      providers[name.trim()] = {
        baseUrl: normalizeBaseUrl(baseUrl, api),
        api,
        // The engine treats a provider without any key as unauthenticated and
        // refuses set_model, so always persist one; local services ignore it.
        apiKey: apiKey.trim() || LOCAL_KEY_PLACEHOLDER,
        ...(Object.keys(compat).length > 0 ? { compat } : {}),
        models: modelLines
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((id) => {
            const k = Number(contextK);
            return Number.isFinite(k) && k > 0 ? { id, contextWindow: Math.round(k * 1000) } : { id };
          }),
      };

      await writeModelsConfig({ providers });
      await chatStore.loadCustomModels();
      chatStore.pushToast(
        isEdit ? "模型配置已更新" : "模型已添加",
        "info",
      );
      onClose(true);
    } catch (err) {
      chatStore.pushToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={() => onClose(false)}
    >
      <div
        className="flex max-h-[85vh] w-[520px] max-w-[92vw] flex-col rounded-xl border border-edge bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold">{isEdit ? "编辑模型" : "添加模型"}</h3>

        {!isEdit && (
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-dim">快速填充：</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  const v = p.apply();
                  if (v.name !== undefined) setName(v.name);
                  if (v.api !== undefined) setApi(v.api as ProviderApi);
                  if (v.baseUrl !== undefined) setBaseUrl(v.baseUrl);
                  if (v.apiKey !== undefined) setApiKey(v.apiKey);
                }}
                className="rounded-md border border-edge px-2.5 py-1 text-xs text-dim hover:text-ink"
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <Field label="Provider 名称" hint="唯一标识，如 my-relay、ollama">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-relay"
              className="w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim disabled:opacity-50"
            />
          </Field>

          <Field label="API 类型">
            <select
              value={api}
              onChange={(e) => setApi(e.target.value as ProviderApi)}
              className="w-full cursor-pointer rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
            >
              {API_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Base URL" hint="Ollama 填 http://localhost:11434/v1">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="mono w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
            />
          </Field>

          <Field label="API Key" hint="本地服务会自动填占位 Key，可任意填">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="mono w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
            />
          </Field>

          <Field label="模型列表" hint="每行一个模型 ID">
            <textarea
              value={modelLines}
              onChange={(e) => setModelLines(e.target.value)}
              rows={4}
              placeholder={"gpt-4o\ndeepseek-v4-flash"}
              className="mono w-full resize-y rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
            />
          </Field>

          <Field label="上下文上限（K）" hint="引擎默认 128K，按需调整">
            <input
              value={contextK}
              onChange={(e) => setContextK(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="200"
              className="mono w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
            />
          </Field>

          <div className="mt-1 flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={noDeveloperRole}
                onChange={(e) => setNoDeveloperRole(e.target.checked)}
              />
              服务器不支持 developer role（改用 system 发送）
            </label>
            <label className="flex items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={noReasoningEffort}
                onChange={(e) => setNoReasoningEffort(e.target.checked)}
              />
              服务器不支持 reasoning_effort
            </label>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={!valid || saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-dim">{label}</span>
        {hint && <span className="text-[11px] text-dim">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
