import { useEffect, useRef, useState } from "react";
import { chatStore, useChatSelector } from "../lib/chat-store";
import type { ModelInfo } from "../types";
import ProviderEditModal from "./ProviderEditModal";

function groupByProvider(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = map.get(m.provider) ?? [];
    list.push(m);
    map.set(m.provider, list);
  }
  return [...map.entries()];
}

export default function ModelPicker() {
  const { models, customModels, currentModel, sessionId } = useChatSelector((s) => ({
    models: s.models,
    customModels: s.customModels,
    currentModel: s.currentModel,
    sessionId: s.sessionId,
  }));
  const [open, setOpen] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Engine catalog wins (richer metadata); custom entries fill the gaps.
  const merged = [...models];
  for (const c of customModels) {
    if (!merged.some((m) => m.provider === c.provider && m.id === c.id)) merged.push(c);
  }
  const groups = groupByProvider(merged);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="选择模型"
        className="flex max-w-44 items-center gap-1 rounded-md border border-edge px-1.5 py-1 text-xs text-dim hover:text-ink"
      >
        <span className="truncate">{currentModel?.name ?? "选择模型"}</span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-edge bg-card py-1 shadow-xl">
          {groups.length === 0 && (
            <div className="px-3 py-2 text-xs text-dim">
              {sessionId ? "暂无可用模型" : "暂无模型，请先添加"}
            </div>
          )}
          {groups.map(([provider, list]) => (
            <div key={provider}>
              <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium text-dim">{provider}</div>
              {list.map((m) => {
                const active = currentModel?.provider === m.provider && currentModel?.id === m.id;
                return (
                  <button
                    key={`${m.provider}/${m.id}`}
                    onClick={() => {
                      setOpen(false);
                      void chatStore.setModel(m.provider, m.id);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-base ${
                      active ? "text-ink" : "text-dim"
                    }`}
                  >
                    <span className="truncate">{m.name || m.id}</span>
                    {active && <span className="text-[var(--ok)]">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}

          {/* Bottom entry: add a custom provider/model. */}
          <div className="mt-1 border-t border-edge pt-1">
            <button
              onClick={() => {
                setOpen(false);
                setShowAddModel(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-dim hover:bg-base hover:text-ink"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
              添加模型
            </button>
          </div>
        </div>
      )}

      {showAddModel && <ProviderEditModal onClose={() => setShowAddModel(false)} />}
    </div>
  );
}
