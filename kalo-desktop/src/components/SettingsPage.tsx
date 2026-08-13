import { useCallback, useEffect, useState, type ReactNode } from "react";
import { chatStore, useChatStore } from "../lib/chat-store";
import {
  createSkill,
  deleteSkill,
  listSkills,
  readAuthConfig,
  readModelsConfig,
  writeAuthConfig,
  writeModelsConfig,
} from "../lib/pi-bridge";
import type { AuthConfig, ModelsConfig, ProviderConfig, SkillMeta } from "../types";
import ProviderEditModal from "./ProviderEditModal";
import SkillEditModal from "./SkillEditModal";

export type ThemePref = "system" | "light" | "dark";

const THEME_KEY = "kalo.theme";

export function loadTheme(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

/** Apply the theme by toggling the `dark` class on <html>. */
export function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

interface SettingsPageProps {
  theme: ThemePref;
  onThemeChange: (t: ThemePref) => void;
  onBack: () => void;
}

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** Common built-in providers that authenticate with a plain API key. */
const BUILTIN_KEY_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "kimi-coding", label: "Kimi For Coding" },
  { id: "minimax-cn", label: "MiniMax（中国）" },
  { id: "zai-coding-cn", label: "ZAI Coding Plan（中国）" },
  { id: "qwen-token-plan-cn", label: "Qwen Token Plan（中国）" },
  { id: "openrouter", label: "OpenRouter" },
];

export default function SettingsPage({ theme, onThemeChange, onBack }: SettingsPageProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <div className="mb-6 flex items-center gap-3">
          <button onClick={onBack} className="rounded-md p-1.5 text-dim hover:bg-card hover:text-ink" title="返回">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold">设置</h1>
        </div>

        <ModelSettings />

        <SkillsSettings />

        <Section title="外观">
          <div className="flex gap-2">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onThemeChange(opt.value)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  theme === opt.value
                    ? "border-dim bg-base text-ink"
                    : "border-edge text-dim hover:text-ink"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="引擎">
          <p className="text-sm leading-relaxed text-dim">
            Kalo 通过内置的 pi 引擎子进程运行，前端与引擎之间使用 NDJSON RPC 协议通信（由 Tauri
            后端负责进程管理）。引擎可执行文件随应用一并打包，无需额外安装。
          </p>
        </Section>

        <Section title="会话存储">
          <p className="text-sm leading-relaxed text-dim">
            会话历史保存在本地目录 <code className="md-inline-code">~/.pi/agent/sessions/</code>
            ，按项目工作目录分组。删除该目录下的文件会移除对应的历史会话。
          </p>
        </Section>

        <Section title="关于">
          <p className="text-sm text-dim">
            Kalo <span className="mono">v0.1.0</span> — AI coding agent 桌面客户端。
          </p>
        </Section>
      </div>
    </div>
  );
}

// ============================================================================
// Model configuration section
// ============================================================================

function ModelSettings() {
  const [modelsConfig, setModelsConfig] = useState<ModelsConfig | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [editing, setEditing] = useState<{ id?: string; config: ProviderConfig } | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [mc, ac] = await Promise.all([readModelsConfig(), readAuthConfig()]);
      setModelsConfig(mc);
      setAuthConfig(ac);
    } catch (err) {
      chatStore.pushToast(`读取模型配置失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const providers = Object.entries(modelsConfig?.providers ?? {});

  const removeProvider = async (id: string) => {
    if (!modelsConfig) return;
    try {
      const next = { ...modelsConfig.providers };
      delete next[id];
      await writeModelsConfig({ providers: next });
      chatStore.pushToast("已删除，新会话生效", "info");
      void reload();
    } catch (err) {
      chatStore.pushToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  return (
    <Section title="模型">
      {/* Custom providers from models.json */}
      <div className="mb-2 text-xs font-medium text-dim">自定义 Provider</div>
      {providers.length === 0 && (
        <p className="mb-2 text-xs text-dim">尚未配置。点击下方"添加模型"接入中转或本地模型服务。</p>
      )}
      <div className="flex flex-col gap-1.5">
        {providers.map(([id, cfg]) => (
          <div key={id} className="flex items-center gap-2 rounded-md border border-edge bg-base px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{id}</div>
              <div className="mono truncate text-xs text-dim">
                {cfg.baseUrl} · {cfg.models.length} 个模型{cfg.apiKey ? " · 已配置 Key" : ""}
              </div>
            </div>
            <button
              onClick={() => {
                setEditing({ id, config: cfg });
                setShowEditor(true);
              }}
              className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
            >
              编辑
            </button>
            <button
              onClick={() => void removeProvider(id)}
              className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => {
          setEditing(null);
          setShowEditor(true);
        }}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
        添加模型
      </button>

      {/* Built-in provider API keys (auth.json) */}
      <div className="mb-2 mt-5 text-xs font-medium text-dim">内置 Provider API Key</div>
      <div className="flex flex-col gap-1.5">
        {BUILTIN_KEY_PROVIDERS.map((p) => (
          <BuiltinKeyRow
            key={p.id}
            id={p.id}
            label={p.label}
            configured={Boolean(authConfig?.[p.id]?.key)}
            onSaved={reload}
          />
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-dim">
        配置写入 <code className="md-inline-code">~/.pi/agent/models.json</code> 与{" "}
        <code className="md-inline-code">~/.pi/agent/auth.json</code>，对新开的对话生效。
      </p>

      {showEditor && (
        <ProviderEditModal
          editing={editing ?? undefined}
          onClose={(saved) => {
            setShowEditor(false);
            if (saved) void reload();
          }}
        />
      )}
    </Section>
  );
}

function BuiltinKeyRow({
  id,
  label,
  configured,
  onSaved,
}: {
  id: string;
  label: string;
  configured: boolean;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const auth = await readAuthConfig();
      auth[id] = { type: "api_key", key: trimmed };
      await writeAuthConfig(auth);
      setKey("");
      chatStore.pushToast(`${label} Key 已保存，新会话生效`, "info");
      onSaved();
    } catch (err) {
      chatStore.pushToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-edge bg-base px-3 py-1.5">
      <span className="w-40 shrink-0 truncate text-sm">{label}</span>
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={configured ? "已配置（输入以覆盖）" : "sk-..."}
        className="mono min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-dim"
      />
      <button
        onClick={() => void save()}
        disabled={!key.trim() || saving}
        className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink disabled:opacity-40"
      >
        保存
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-edge bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

// ============================================================================
// Skills management section
// ============================================================================

function SkillsSettings() {
  const { cwd } = useChatStore();
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [editing, setEditing] = useState<SkillMeta | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"user" | "project">("project");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSkills(await listSkills(cwd || undefined));
    } catch (err) {
      chatStore.pushToast(`加载 Skills 失败：${errText(err)}`, "error");
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (s: SkillMeta) => {
    if (!window.confirm(`确定删除 Skill「${s.name}」？该操作不可恢复。`)) return;
    try {
      await deleteSkill(s.path);
      chatStore.pushToast(`已删除 ${s.name}`, "info");
      void reload();
    } catch (err) {
      chatStore.pushToast(`删除失败：${errText(err)}`, "error");
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    if (newScope === "project" && !cwd) {
      chatStore.pushToast("项目级 Skill 需要先在对话中设置工作目录", "warning");
      return;
    }
    setCreating(true);
    try {
      const path = await createSkill(name, newScope, newScope === "project" ? cwd : undefined);
      setShowCreate(false);
      setNewName("");
      void reload();
      // Open the editor on the fresh SKILL.md right away.
      setEditing({ name, description: "", path, scope: newScope, isDir: true });
    } catch (err) {
      chatStore.pushToast(`创建 Skill 失败：${errText(err)}`, "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Section title="Skills">
      {skills === null ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : skills.length === 0 ? (
        <p className="mb-2 text-xs text-dim">暂无 Skill。Skill 是带给引擎的复用指令（SKILL.md）。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {skills.map((s) => (
            <div key={s.path} className="flex items-center gap-2 rounded-md border border-edge bg-base px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{s.name}</span>
                  <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">
                    {s.scope === "user" ? "全局" : "项目"}
                  </span>
                </div>
                {s.description && <div className="truncate text-xs text-dim">{s.description}</div>}
              </div>
              <button
                onClick={() => setEditing(s)}
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
              >
                编辑
              </button>
              <button
                onClick={() => void remove(s)}
                className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {showCreate ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="skill 名称，如 pdf-tools"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            className="mono min-w-0 flex-1 rounded-md border border-edge bg-base px-3 py-1.5 text-sm outline-none focus:border-dim"
          />
          <select
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as "user" | "project")}
            className="cursor-pointer rounded-md border border-edge bg-transparent px-1.5 py-1.5 text-xs text-dim outline-none hover:text-ink"
          >
            <option value="project">项目</option>
            <option value="user">全局</option>
          </select>
          <button
            onClick={() => void create()}
            disabled={!newName.trim() || creating}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
          >
            {creating ? "创建中…" : "创建"}
          </button>
          <button
            onClick={() => setShowCreate(false)}
            className="shrink-0 rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowCreate(true)}
          className="mt-2 flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
          </svg>
          新建 Skill
        </button>
      )}

      {editing && (
        <SkillEditModal
          skill={editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) void reload();
          }}
        />
      )}
    </Section>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
