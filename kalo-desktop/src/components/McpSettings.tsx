import { useCallback, useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { readMcpConfig, readMcpStatus, writeMcpConfig } from "../lib/pi-bridge";
import type { McpConfig, McpServerDef, McpStatus } from "../types";
import { Section } from "./SettingsPage";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Draft row while editing/creating: McpServerDef plus name + args text. */
interface ServerDraft {
  name: string;
  command: string;
  /** One arg per line (avoids quoting pitfalls of a single-line split). */
  argsText: string;
  /** Optional env as `KEY=value` lines. */
  envText: string;
  enabled: boolean;
}

function toDraft(name: string, def: McpServerDef): ServerDraft {
  return {
    name,
    command: def.command ?? "",
    argsText: (def.args ?? []).join("\n"),
    envText: Object.entries(def.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    enabled: def.enabled !== false,
  };
}

function draftToDef(draft: ServerDraft): McpServerDef | null {
  const command = draft.command.trim();
  if (!command) return null;
  const args = draft.argsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const env: Record<string, string> = {};
  for (const line of draft.envText.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    enabled: draft.enabled,
  };
}

/**
 * MCP tab (P1-A): manages ~/.kalo/agent/mcp.json. The engine spawns the
 * configured stdio servers at session start and mirrors the handshake
 * result to mcp-status.json, which this panel displays.
 */
export default function McpSettings() {
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [status, setStatus] = useState<McpStatus | null>(null);
  /** null/undefined = closed, draft object = creating or editing. */
  const [editing, setEditing] = useState<ServerDraft | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([readMcpConfig(), readMcpStatus()]);
      setConfig(cfg);
      setStatus(st);
    } catch (err) {
      chatStore.pushToast(`加载 MCP 配置失败：${errText(err)}`, "error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const persist = useCallback(
    async (mutate: (servers: Record<string, McpServerDef>) => Record<string, McpServerDef>) => {
      if (!config) return;
      const next: McpConfig = { servers: mutate({ ...config.servers }) };
      setSaving(true);
      try {
        await writeMcpConfig(next);
        setConfig(next);
      } catch (err) {
        chatStore.pushToast(`保存失败：${errText(err)}`, "error");
      } finally {
        setSaving(false);
      }
    },
    [config],
  );

  const saveDraft = useCallback(
    async (originalName: string | undefined, draft: ServerDraft) => {
      const def = draftToDef(draft);
      const name = draft.name.trim();
      if (!def) {
        chatStore.pushToast("command 不能为空", "error");
        return;
      }
      if (!/^[\w.-]{1,48}$/.test(name)) {
        chatStore.pushToast("名称只允许字母、数字、- _ .，长度 ≤ 48", "error");
        return;
      }
      if (name !== originalName && config?.servers[name]) {
        chatStore.pushToast(`已存在同名 server：${name}`, "error");
        return;
      }
      await persist((servers) => {
        if (originalName && originalName !== name) delete servers[originalName];
        servers[name] = def;
        return servers;
      });
      setEditing(null);
    },
    [config, persist],
  );

  const entries = Object.entries(config?.servers ?? {});

  return (
    <Section title="MCP 服务器">
      <p className="mb-3 text-xs text-dim">
        通过 stdio 接入 MCP server，工具会以 <span className="mono">mcp_服务器_工具</span> 的形式注入会话
        （仅本地进程、配置存于 ~/.kalo/agent/mcp.json）。修改后对新会话生效；工具清单在最近一次会话握手后显示。
      </p>

      {config === null ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : entries.length === 0 ? (
        <p className="mb-2 text-xs text-dim">尚未配置 MCP server。点击「添加服务器」开始。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map(([name, def]) => {
            const st = status?.servers[name];
            return (
              <div key={name} className="rounded-md border border-edge bg-base px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{name}</span>
                      {st ? (
                        st.ok ? (
                          <span className="shrink-0 text-[10px] text-[var(--ok)]">已连接 · {st.tools.length} 工具</span>
                        ) : (
                          <span className="shrink-0 text-[10px] text-[var(--danger)]">握手失败</span>
                        )
                      ) : (
                        <span className="shrink-0 text-[10px] text-dim">等待下次会话加载</span>
                      )}
                      {def.enabled === false && (
                        <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">已停用</span>
                      )}
                    </div>
                    <div className="mono truncate text-xs text-dim" title={def.command}>
                      {def.command} {(def.args ?? []).join(" ")}
                    </div>
                    {st && !st.ok && st.error && (
                      <div className="mono mt-0.5 line-clamp-2 text-[10px] text-[var(--danger)]" title={st.error}>
                        {st.error}
                      </div>
                    )}
                    {st?.ok && st.tools.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[10px] text-dim hover:text-ink">工具清单</summary>
                        <div className="mt-1 flex flex-col gap-0.5">
                          {st.tools.map((t) => (
                            <div key={t.name} className="flex items-baseline gap-1.5 text-[11px]">
                              <span className="mono shrink-0">{t.name}</span>
                              {t.description && (
                                <span className="truncate text-dim" title={t.description}>
                                  {t.description}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                  <button
                    onClick={() => void persist((servers) => {
                      servers[name] = { ...def, enabled: def.enabled === false };
                      return servers;
                    })}
                    disabled={saving}
                    className="shrink-0 rounded border border-edge px-2 py-1 text-[11px] text-dim hover:bg-card hover:text-ink"
                  >
                    {def.enabled === false ? "启用" : "停用"}
                  </button>
                  <button
                    onClick={() => setEditing(toDraft(name, def))}
                    className="shrink-0 rounded border border-edge px-2 py-1 text-[11px] text-dim hover:bg-card hover:text-ink"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`确定删除 MCP server「${name}」？`)) {
                        void persist((servers) => {
                          delete servers[name];
                          return servers;
                        });
                      }
                    }}
                    className="shrink-0 rounded border border-edge px-2 py-1 text-[11px] text-[var(--danger)] hover:bg-card"
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => setEditing(toDraft("", { command: "" }))}
          className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-card"
        >
          添加服务器
        </button>
      </div>

      {editing !== null && editing !== undefined && (
        <ServerEditModal
          draft={editing}
          originalName={editing.name || undefined}
          onCancel={() => setEditing(null)}
          onSave={(d) => void saveDraft(editing.name || undefined, d)}
        />
      )}
    </Section>
  );
}

function ServerEditModal({
  draft,
  originalName,
  onCancel,
  onSave,
}: {
  draft: ServerDraft;
  originalName: string | undefined;
  onCancel: () => void;
  onSave: (draft: ServerDraft) => void;
}) {
  const [d, setD] = useState<ServerDraft>(draft);
  const input = "w-full rounded-md border border-edge bg-base px-2 py-1.5 text-sm outline-none focus:border-dim";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="w-[480px] max-w-[90vw] rounded-lg border border-edge bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-medium">{originalName ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</h3>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-dim">
            名称（工具名前缀）
            <input
              className={input}
              value={d.name}
              placeholder="akshare"
              onChange={(e) => setD({ ...d, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim">
            命令
            <input
              className={`${input} mono`}
              value={d.command}
              placeholder="uvx / npx.cmd / node / 可执行文件路径"
              onChange={(e) => setD({ ...d, command: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim">
            参数（每行一个）
            <textarea
              className={`${input} mono h-20 resize-none`}
              value={d.argsText}
              placeholder={"akshare-mcp\n--port\n8000"}
              onChange={(e) => setD({ ...d, argsText: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim">
            环境变量（可选，每行 KEY=value）
            <textarea
              className={`${input} mono h-16 resize-none`}
              value={d.envText}
              placeholder={"AKSHARE_TOKEN=xxx"}
              onChange={(e) => setD({ ...d, envText: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-dim">
            <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
            启用
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base">
            取消
          </button>
          <button
            onClick={() => onSave(d)}
            className="rounded-md bg-ink px-3 py-1.5 text-sm text-base hover:opacity-90"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
