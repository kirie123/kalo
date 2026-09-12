import { useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { readModelsConfig, writeModelsConfig } from "../lib/pi-bridge";
import {
  applyProviderEntry,
  buildProviderEntry,
  defaultContextK,
  defaultMaxOutK,
  LOCAL_KEY_PLACEHOLDER,
  previousEntryFor,
  readAuthHeader,
  readCapability,
} from "../lib/provider-config";
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

/** Quick-fill presets for common local model services. */
const PRESETS: Array<{ label: string; apply: () => Partial<Record<string, string>> }> = [
  {
    label: "Ollama",
    apply: () => ({
      name: "ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      apiKey: LOCAL_KEY_PLACEHOLDER,
      contextK: "128",
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
  const [contextK, setContextK] = useState(() =>
    editing ? defaultContextK(editing.id ?? "", editing.config) : "200",
  );
  // Shared max output for all models, in K tokens; empty = engine default.
  const [maxOutK, setMaxOutK] = useState(() =>
    editing ? defaultMaxOutK(editing.config) : "",
  );
  // Capability switches apply to every model of this provider. A provider
  // whose models disagree starts unchecked and is unified on save.
  const [reasoning, setReasoning] = useState(
    () => editing !== undefined && readCapability(editing.config.models, "reasoning") === "all",
  );
  const [images, setImages] = useState(
    () => editing !== undefined && readCapability(editing.config.models, "images") === "all",
  );
  const [authHeader, setAuthHeader] = useState(() => readAuthHeader(editing?.config));
  const [capabilityMixed] = useState(() => {
    if (!editing) return { reasoning: false, images: false };
    return {
      reasoning: readCapability(editing.config.models, "reasoning") === "mixed",
      images: readCapability(editing.config.models, "images") === "mixed",
    };
  });
  const [noDeveloperRole, setNoDeveloperRole] = useState(
    editing?.config.compat?.supportsDeveloperRole === false,
  );  const [noReasoningEffort, setNoReasoningEffort] = useState(
    editing?.config.compat?.supportsReasoningEffort === false,
  );
  const [saving, setSaving] = useState(false);
  /**
   * Providers already in models.json, offered as one-click fills so adding a
   * model to a relay you have configured does not mean retyping its URL/key.
   */
  const [known, setKnown] = useState<Array<[string, ProviderConfig]>>([]);

  const isEdit = editing?.id !== undefined;

  useEffect(() => {
    if (isEdit) return;
    let alive = true;
    void readModelsConfig()
      .then((c) => {
        if (alive) setKnown(Object.entries(c.providers ?? {}));
      })
      // A missing/unreadable models.json just means no chips to offer.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isEdit]);

  /** Load an existing provider's connection settings and current model list. */
  const applyKnown = (id: string, cfg: ProviderConfig) => {
    setName(id);
    setApi(cfg.api);
    setBaseUrl(cfg.baseUrl);
    setApiKey(cfg.apiKey ?? "");
    setModelLines(cfg.models.map((m) => m.id).join("\n"));
    setContextK(defaultContextK(id, cfg));
    setMaxOutK(defaultMaxOutK(cfg));
    setReasoning(readCapability(cfg.models, "reasoning") === "all");
    setImages(readCapability(cfg.models, "images") === "all");
    setAuthHeader(readAuthHeader(cfg));
    setNoDeveloperRole(cfg.compat?.supportsDeveloperRole === false);
    setNoReasoningEffort(cfg.compat?.supportsReasoningEffort === false);
  };

  const valid =
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    modelLines.split("\n").some((l) => l.trim() !== "");

  /** Adding under a name that already exists → the entry is merged, not new. */
  const reusing = !isEdit && known.some(([id]) => id === name.trim());

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const modelsConfig = await readModelsConfig();
      const providers = { ...(modelsConfig.providers ?? {}) };
      const target = name.trim();

      // Merging with the stored entry keeps hand-written fields the form does
      // not own (authHeader, headers, oauth, modelOverrides, per-model cost).
      const entry = buildProviderEntry(
        {
          name: target,
          api,
          baseUrl,
          apiKey,
          modelLines,
          contextK,
          maxOutK,
          reasoning,
          images,
          authHeader,
          noDeveloperRole,
          noReasoningEffort,
        },
        previousEntryFor(providers, target, editing?.id),
      );

      await writeModelsConfig({
        ...modelsConfig,
        providers: applyProviderEntry(providers, target, entry, editing?.id),
      });
      await chatStore.loadCustomModels();
      chatStore.pushToast(isEdit || reusing ? "模型配置已更新" : "模型已添加", "info");
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
          <div className="mb-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-dim">快速填充：</span>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    const v = p.apply();
                    if (v.name !== undefined) setName(v.name);
                    if (v.api !== undefined) setApi(v.api as ProviderApi);
                    if (v.baseUrl !== undefined) setBaseUrl(v.baseUrl);
                    if (v.apiKey !== undefined) setApiKey(v.apiKey);
                    if (v.contextK !== undefined) setContextK(v.contextK);
                  }}
                  className="rounded-md border border-edge px-2.5 py-1 text-xs text-dim hover:text-ink"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {known.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="shrink-0 pt-1 text-xs text-dim">已有 Provider：</span>
                <div className="flex flex-wrap gap-1.5">
                  {known.map(([id, cfg]) => {
                    const active = name.trim() === id;
                    return (
                      <button
                        key={id}
                        onClick={() => applyKnown(id, cfg)}
                        title={`${cfg.baseUrl} · ${cfg.models.length} 个模型`}
                        className={`rounded-md border px-2.5 py-1 text-xs ${
                          active
                            ? "border-accent text-ink"
                            : "border-edge text-dim hover:text-ink"
                        }`}
                      >
                        {id}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <Field
            label="Provider 名称"
            hint={
              reusing ? "已有 Provider，保存后合并模型列表" : "唯一标识，如 my-relay、ollama"
            }
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-relay"
              list={known.length > 0 ? "kalo-known-providers" : undefined}
              className="w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim disabled:opacity-50"
            />
            {known.length > 0 && (
              <datalist id="kalo-known-providers">
                {known.map(([id]) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            )}
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

          <Field
            label="模型列表"
            hint={reusing ? "已载入现有模型，换行追加即可" : "每行一个模型 ID"}
          >
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

          <Field label="最大输出（K）" hint="留空用引擎默认（16K）">
            <input
              value={maxOutK}
              onChange={(e) => setMaxOutK(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="64"
              className="mono w-full rounded-md border border-edge bg-base px-3 py-2 text-sm outline-none focus:border-dim"
            />
          </Field>

          <div className="mt-1 flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(e) => setReasoning(e.target.checked)}
              />
              模型支持思考（reasoning）
              {capabilityMixed.reasoning && (
                <span className="text-[11px]">当前模型取值不一致，保存后统一写入</span>
              )}
            </label>
            <label className="flex items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={images}
                onChange={(e) => setImages(e.target.checked)}
              />
              模型支持图片输入（vision）
              {capabilityMixed.images && (
                <span className="text-[11px]">当前模型取值不一致，保存后统一写入</span>
              )}
            </label>
            <label className="flex items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={authHeader}
                onChange={(e) => setAuthHeader(e.target.checked)}
              />
              用 <span className="mono">Authorization: Bearer</span> 发送密钥
            </label>
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
