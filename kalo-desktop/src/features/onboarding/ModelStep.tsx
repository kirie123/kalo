/**
 * 引导第 5 步：把模型配起来。
 *
 * 这一步的目标不是「把设置页搬过来」——设置页要能改所有东西，这里只要能
 * 让人发出第一条消息：填一个 Key（或接一个本地服务），选一个模型，验一下
 * 通不通。所以复用的是数据与弹窗（`BUILTIN_KEY_PROVIDERS`、
 * `ProviderEditModal`、`readAuthConfig` / `writeAuthConfig`），不复用版式。
 *
 * 模型下拉里的候选一律来自引擎（`listEngineModels`），不在前端硬编码任何
 * 模型 ID：模型列表跟引擎版本走，前端抄一份就一定会过期，而过期的下拉框比
 * 空下拉框更坑人——用户会以为是自己填错了。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { chatStore } from "../../lib/chat-store";
import { readAuthConfig, writeAuthConfig } from "../../lib/pi-bridge";
import { BUILTIN_KEY_PROVIDERS } from "../../components/SettingsPage";
import ProviderEditModal from "../../components/ProviderEditModal";
import type { ModelInfo } from "../../types";
import { listEngineModels, probeModel, type ProbeResult } from "./probe";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ModelStep() {
  const [providerId, setProviderId] = useState(BUILTIN_KEY_PROVIDERS[0]?.id ?? "deepseek");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState<Set<string>>(new Set());

  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [picked, setPicked] = useState<string>("");   // "provider/modelId"
  const [showProviderModal, setShowProviderModal] = useState(false);

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  /** 引擎只在启动时读 auth.json / models.json，所以每次配置变更都重新问一遍。 */
  const reload = useCallback(async () => {
    setModels(null);
    try {
      const auth = await readAuthConfig();
      setConfigured(new Set(Object.keys(auth).filter((k) => auth[k]?.key)));
    } catch {
      // 读不到就当没配过，下面的下拉框会是空的，用户自己会发现。
    }
    const list = await listEngineModels();
    setModels(list);
    // 之前选中的还在就别动它：重新拉列表往往是因为刚加了一个 provider。
    setPicked((cur) => (cur && list.some((m) => `${m.provider}/${m.id}` === cur) ? cur : ""));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models ?? []) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()];
  }, [models]);

  const saveKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setResult(null);
    try {
      const auth = await readAuthConfig();
      auth[providerId] = { type: "api_key", key: trimmed };
      await writeAuthConfig(auth);
      setApiKey("");
      await reload();
    } catch (err) {
      setResult({ ok: false, summary: `保存失败：${errText(err)}` });
    } finally {
      setSaving(false);
    }
  };

  /** 选中即生效：没有会话时 setModel 只落偏好，下次开会话自动套上。 */
  const choose = (value: string) => {
    setPicked(value);
    setResult(null);
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    void chatStore.setModel(value.slice(0, slash), value.slice(slash + 1));
    void chatStore.loadCustomModels();
  };

  const test = async () => {
    const slash = picked.indexOf("/");
    if (slash <= 0 || testing) return;
    setTesting(true);
    setResult(null);
    setDetailOpen(false);
    setResult(await probeModel(picked.slice(0, slash), picked.slice(slash + 1)));
    setTesting(false);
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 text-left">
      {/* 一、内置 Provider 的 Key */}
      <div className="rounded-xl border border-edge bg-card p-4">
        <div className="mb-2 text-xs font-medium text-dim">填一个 API Key</div>
        <div className="flex items-center gap-2">
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="shrink-0 rounded-md border border-edge bg-base px-2 py-1.5 text-sm outline-none"
          >
            {BUILTIN_KEY_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {configured.has(p.id) ? " ✓" : ""}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            placeholder={configured.has(providerId) ? "已配置（输入以覆盖）" : "sk-..."}
            className="mono min-w-0 flex-1 rounded-md border border-edge bg-base px-2 py-1.5 text-xs outline-none placeholder:text-dim"
          />
          <button
            onClick={() => void saveKey()}
            disabled={!apiKey.trim() || saving}
            className="shrink-0 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        <p className="mt-2 text-xs text-dim">
          Key 写入 <code className="md-inline-code">~/.kalo/agent/auth.json</code>，只留在本机。
          也可以{" "}
          <button
            onClick={() => setShowProviderModal(true)}
            className="text-accent underline underline-offset-2 hover:opacity-80"
          >
            接入中转或本地模型
          </button>
          （Ollama / LM Studio / 各家中转）。
        </p>
      </div>

      {/* 二、选一个默认模型 */}
      <div className="rounded-xl border border-edge bg-card p-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-dim">
          <span>选一个默认模型</span>
          <button
            onClick={() => void reload()}
            className="ml-auto rounded border border-edge px-1.5 py-0.5 text-xs font-normal hover:text-ink"
          >
            刷新
          </button>
        </div>
        {models === null ? (
          <div className="text-xs text-dim">正在向引擎询问可用模型…</div>
        ) : groups.length === 0 ? (
          <div className="text-xs text-dim">还没有可用模型——先在上面填一个 Key，或接入本地模型服务。</div>
        ) : (
          <select
            value={picked}
            onChange={(e) => choose(e.target.value)}
            className="w-full rounded-md border border-edge bg-base px-2 py-1.5 text-sm outline-none"
          >
            <option value="">请选择…</option>
            {groups.map(([provider, list]) => (
              <optgroup key={provider} label={provider}>
                {list.map((m) => (
                  <option key={`${provider}/${m.id}`} value={`${provider}/${m.id}`}>
                    {m.name || m.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void test()}
            disabled={!picked || testing}
            className="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-40"
          >
            {testing ? "测试中…" : "测试连通"}
          </button>
          <span className="text-xs text-dim">会真的调一次模型，消耗极少量 token。</span>
        </div>

        {result && (
          <div
            className={`mt-2 rounded-md border px-3 py-1.5 text-xs ${
              result.ok
                ? "border-edge bg-base text-[var(--ok)]"
                : "border-[var(--warn-border)] bg-[var(--warn-bg)] text-ink"
            }`}
          >
            <button
              onClick={() => setDetailOpen((v) => !v)}
              disabled={!result.detail}
              className="flex w-full items-center gap-2 text-left"
            >
              <span className="font-medium">
                {result.ok ? "✓" : "✗"} {result.summary}
              </span>
              {result.detail && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={`ml-auto shrink-0 opacity-60 transition-transform ${detailOpen ? "rotate-90" : ""}`}
                >
                  <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            {detailOpen && result.detail && (
              <pre className="mono mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 opacity-80">
                {result.detail}
              </pre>
            )}
          </div>
        )}
      </div>

      <p className="text-center text-xs text-dim">
        现在不配也行——之后在 设置 → 模型 里随时可以补。
      </p>

      {showProviderModal && (
        <ProviderEditModal
          onClose={(saved) => {
            setShowProviderModal(false);
            if (saved) void reload();
          }}
        />
      )}
    </div>
  );
}
