import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useChatSelector } from "../lib/chat-store";
import { formatK } from "../lib/run-usage";
import {
  agentActivitySummary,
  agentStatusView,
  collectSubagents,
  sameSubagentNodes,
  type SubagentNode,
  type SubagentStatus,
} from "../lib/subagent-map";
import AgentActivityFeed from "./AgentActivityFeed";
import CopyButton from "./CopyButton";

/**
 * Agent map: every child agent of the current session, with its live feed.
 *
 * Opened from the composer's `N 个子 agent` button
 * (doc/2026-09-30-子agent活动面板.md). The tree is one level deep by design —
 * children run with a trimmed toolset that has no `agent` tool, so a child
 * cannot spawn children.
 *
 * Read-only on purpose: stopping or resuming a child stays in the conversation
 * (its tool card), so this modal never becomes a second control surface.
 */
export default function AgentMapModal({ onClose }: { onClose: () => void }) {
  // The timeline churns at ~20fps while streaming; sameSubagentNodes keeps this
  // modal from re-rendering for commits that did not move an agent. A child's
  // activity feed is compared by reference, so live steps still come through.
  const nodes = useChatSelector((s) => collectSubagents(s.timeline), sameSubagentNodes);
  const sessionName = useChatSelector((s) => s.sessionName);
  const modelName = useChatSelector((s) => s.currentModel?.name);
  const contextTokens = useChatSelector((s) => s.contextUsage?.tokens ?? null);
  const isStreaming = useChatSelector((s) => s.isStreaming);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const running = nodes.filter((n) => n.status === "running").length;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-edge bg-card shadow-2xl"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
          <span className="text-sm text-ink">子 Agent</span>
          <span className="min-w-0 flex-1 truncate text-xs text-dim">
            {nodes.length} 个子 agent
            {running > 0 && ` · ${running} 个运行中`}
            {nodes.length > 0 && " · 点击节点查看详情"}
          </span>
          <button onClick={onClose} title="关闭" className="shrink-0 rounded p-1 text-dim hover:bg-base hover:text-ink">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {nodes.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-10 text-center">
              <span className="text-xs text-ink">本会话还没有派生子 agent</span>
              <span className="text-[11px] text-dim">模型用 agent 工具派生独立任务后，会实时出现在这里</span>
            </div>
          ) : (
            <div className="flex gap-5">
              <div className="w-52 shrink-0">
                <div className="rounded-lg border border-edge bg-base p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex w-3 shrink-0 justify-center">
                      {isStreaming ? (
                        <span className="spinner" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-edge" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{sessionName || "当前会话"}</span>
                  </div>
                  <div className="mono mt-1.5 pl-5 text-[11px] text-dim">
                    {modelName ?? "未知模型"}
                    {contextTokens !== null && ` · ${formatK(contextTokens)} tokens`}
                  </div>
                </div>
              </div>

              {/* Children column: the left border plus one tick per row is the
                  "derived from the main session" connector. */}
              <div className="flex min-w-0 flex-1 flex-col gap-2 border-l border-edge pl-5">
                {nodes.map((node) => (
                  <div key={node.key} className="relative">
                    <span aria-hidden className="absolute -left-5 top-4 h-px w-5 bg-edge" />
                    <NodeCard
                      node={node}
                      expanded={isExpanded(node, expanded)}
                      onToggle={() => setExpanded((cur) => (isExpanded(node, cur) ? null : node.key))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NodeCard({ node, expanded, onToggle }: { node: SubagentNode; expanded: boolean; onToggle: () => void }) {
  const view = agentStatusView(node);
  const summary = agentActivitySummary(node);

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-base">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        title={node.prompt || node.title}
        className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-card"
      >
        <span className="mt-0.5 flex w-3 shrink-0 justify-center">
          <StatusMark status={node.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-ink">{node.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-dim">
            <span className={statusTone(view.tone)}>{view.label}</span>
            {node.steps !== undefined && (
              <span className="mono">
                {node.status === "running" ? `第 ${node.steps} 步` : `共 ${node.steps} 步`}
              </span>
            )}
            {node.tokens !== undefined && <span className="mono">{formatK(node.tokens)} tokens</span>}
            {node.calls > 1 && <span>续写 {node.calls - 1} 次</span>}
          </span>
          {summary && <span className="mono mt-1 block truncate text-[11px] text-dim">{summary}</span>}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`mt-1 shrink-0 text-dim transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M3.5 6.5L8 11l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-edge px-3 py-2.5">
          <div className="mono mb-1.5 flex items-center gap-2 text-[11px] text-dim">
            <span className="truncate">
              {node.id ?? "（运行中，尚未分配 id）"} · {(node.tools ?? []).join("/") || "默认工具集"}
            </span>
          </div>

          <div className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-card p-2 text-[11px] text-dim">
            {node.prompt || "（模型没有给出任务描述）"}
          </div>

          {node.errorMessage && (
            <div className="mb-2 rounded-md border border-[var(--error-border)] bg-[var(--error-bg)] px-2 py-1 text-[11px] text-[var(--danger)]">
              {node.errorMessage}
            </div>
          )}

          {node.activity?.length ? (
            <AgentActivityFeed activity={node.activity} />
          ) : (
            <div className="text-[11px] text-dim">（暂无活动流）</div>
          )}

          {node.transcriptPath && (
            <div className="mt-2 flex items-center gap-1 border-t border-edge pt-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={node.transcriptPath}>
                过程转录：<span className="mono">{node.transcriptPath}</span>
              </span>
              <CopyButton text={node.transcriptPath} title="复制转录路径" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A running fresh child is keyed on its call id until the result lands and
 * names it (`subagent-N`); matching on both keeps an open node from snapping
 * shut at the moment it settles.
 */
function isExpanded(node: SubagentNode, expanded: string | null): boolean {
  return expanded !== null && (node.key === expanded || node.toolCallId === expanded);
}

/** State mark shared with the tool rows' visual language (spinner / ✓ / ✗). */
function StatusMark({ status }: { status: SubagentStatus }) {
  if (status === "running") return <span className="spinner" />;
  if (status === "done") return <span className="text-[var(--ok)]">✓</span>;
  if (status === "failed") return <span className="text-[var(--danger)]">✗</span>;
  return <span className="text-tone-orange">!</span>;
}

function statusTone(tone: ReturnType<typeof agentStatusView>["tone"]): string {
  if (tone === "ok") return "text-[var(--ok)]";
  if (tone === "danger") return "text-[var(--danger)]";
  if (tone === "warn") return "text-tone-orange";
  return "text-ink";
}