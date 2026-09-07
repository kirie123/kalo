/**
 * 数字专家 panel (doc/2026-08-29-digital-experts.md, M1: read-only + 开始会话).
 *
 * Left: one card per registry entry. Right: the selected expert's live state —
 * running sessions, memory files, its scheduled tasks, and its workdir.
 *
 * Everything derives from three already-existing sources: expert_list,
 * jobs_list (running sessions + task table) and list_dir on
 * <workdir>/.kalo/memory. Aggregation and formatting live in
 * lib/expert-view.ts so the rules stay testable; this file only renders.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { chatStore } from "../../lib/chat-store";
import {
  expertCards,
  expertDetail,
  fmtNextRun,
  fmtStartedAt,
  memoryDirPath,
  missionSummary,
  sessionTitles,
} from "../../lib/expert-view";
import { startFreshChat } from "../../lib/fresh-chat";
import { expertList, jobsList, listDir, listSessions, openPath, readFileText } from "../../lib/pi-bridge";
import type { DirEntry, Expert, JobsSnapshot, ProjectGroup } from "../../types";

/** Running sessions and next runs change without the panel doing anything. */
const POLL_MS = 10_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function ExpertsPanel({ onLeaveToChat }: { onLeaveToChat: () => void }) {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [snap, setSnap] = useState<JobsSnapshot | null>(null);
  const [sessionGroups, setSessionGroups] = useState<ProjectGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    expertList()
      .then(setExperts)
      .catch((err) => chatStore.pushToast(`加载专家列表失败：${errText(err)}`, "error"));
    // Session titles live in the on-disk session store; loading them lets the
    // 进行中 section show "当前账户与宏观环境盘点" instead of "桌面 会话".
    listSessions()
      .then(setSessionGroups)
      .catch(() => {});
    // jobs_list fails when the gateway is down; that is an ordinary state
    // here, so the panel keeps the last snapshot instead of an error toast.
    jobsList()
      .then(setSnap)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Keep the selection valid across reloads; default to the first expert.
  useEffect(() => {
    if (selectedId && experts.some((e) => e.id === selectedId)) return;
    setSelectedId(experts[0]?.id ?? null);
  }, [experts, selectedId]);

  const running = snap?.running ?? [];
  const tasks = snap?.tasks ?? [];
  const cards = expertCards(experts, running, tasks);
  const selected = experts.find((e) => e.id === selectedId) ?? null;

  const startSession = (expert: Expert) => {
    // The engine spawns lazily on the first prompt; the expertId rides on the
    // chat runtime, so the session (and any crash recovery) runs with the
    // expert's identity and memory dir.
    chatStore.newChat({ cwd: expert.workdir, expertId: expert.id });
    chatStore.pushToast(`已为「${expert.name}」开启新会话`, "info");
    onLeaveToChat();
  };

  /** M2: creating an expert is an ordinary session driven by expert-designer. */
  const createExpert = async () => {
    // A fresh workspace: expert-designer plans and creates the expert's own
    // directory, so it must not start inside whatever project was last open.
    await startFreshChat();
    onLeaveToChat();
    try {
      await chatStore.sendPrompt(
        "请用 expert-designer 技能，带我创建一个新的数字专家。先按流程问清使命、数据、频率和产出。",
      );
    } catch (e) {
      chatStore.pushToast(`没能开始创建会话：${errText(e)}`, "error");
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Expert list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-edge">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium">数字专家</span>
          <div className="flex items-center gap-2">
            <button onClick={() => void createExpert()} className="text-xs text-dim hover:text-ink">
              + 新建
            </button>
            <button onClick={refresh} className="text-xs text-dim hover:text-ink">
              刷新
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {cards.length === 0 ? (
            <p className="px-2 py-1 text-xs leading-relaxed text-dim">
              还没有数字专家。点右上角「+ 新建」，由一个创建会话带你规划并注册。
            </p>
          ) : (
            cards.map((card) => (
              <button
                key={card.expert.id}
                onClick={() => setSelectedId(card.expert.id)}
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-left hover:bg-card ${
                  card.expert.id === selectedId ? "border-dim bg-card" : "border-edge"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.expert.name}</span>
                  {!card.expert.enabled && <span className="shrink-0 text-[10px] text-dim">已停用</span>}
                  {card.runningCount > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--ok)]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                      {card.runningCount} 进行中
                    </span>
                  )}
                </div>
                <span className="truncate text-xs text-dim" title={card.expert.mission}>
                  {missionSummary(card.expert.mission) || "（未填写使命）"}
                </span>
                <span className="text-[10px] text-dim">
                  下次定时触发 {fmtNextRun(card.nextRunAt)} · {card.enabledTaskCount} 个启用任务
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <ExpertDetailPanel
            key={selected.id}
            expert={selected}
            snap={snap}
            titles={sessionTitles(sessionGroups)}
            onStartSession={() => startSession(selected)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs leading-relaxed text-dim">
            选择左侧的专家查看状态。
          </div>
        )}
      </div>
    </div>
  );
}

function ExpertDetailPanel({
  expert,
  snap,
  titles,
  onStartSession,
}: {
  expert: Expert;
  snap: JobsSnapshot | null;
  titles: Map<string, string>;
  onStartSession: () => void;
}) {
  const detail = expertDetail(expert.id, snap?.running ?? [], snap?.tasks ?? [], titles);

  const [memories, setMemories] = useState<DirEntry[] | null>(null);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [openMemory, setOpenMemory] = useState<{ path: string; text: string; truncated: boolean } | null>(null);

  // The memory dir only exists after the expert's first memory_save — a
  // missing directory is an ordinary state, shown as a note rather than a toast.
  useEffect(() => {
    let alive = true;
    listDir(memoryDirPath(expert.workdir))
      .then((entries) => {
        if (!alive) return;
        setMemories(entries.filter((e) => !e.isDir && e.name.endsWith(".md")));
        setMemoryNote(null);
      })
      .catch(() => {
        if (!alive) return;
        setMemories([]);
        setMemoryNote("还没有记忆目录，专家首次写入记忆后会出现。");
      });
    return () => {
      alive = false;
    };
  }, [expert.workdir]);

  const toggleMemory = async (entry: DirEntry) => {
    if (openMemory?.path === entry.path) {
      setOpenMemory(null);
      return;
    }
    try {
      const content = await readFileText(entry.path, 64 * 1024);
      setOpenMemory({ path: entry.path, text: content.text, truncated: content.truncated });
    } catch (err) {
      chatStore.pushToast(`读取记忆失败：${errText(err)}`, "error");
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 px-6 py-5">
      <div className="rounded-lg border border-edge bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{expert.name}</span>
          {!expert.enabled && <span className="shrink-0 text-[10px] text-dim">已停用</span>}
          <button
            onClick={onStartSession}
            className="shrink-0 rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-base"
          >
            开始会话
          </button>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-dim">{expert.mission}</p>
        <div className="mono mt-2 truncate text-[10px] text-dim" title={expert.workdir}>
          {expert.workdir}
        </div>
      </div>

      {/* 进行中 */}
      <Section title="进行中" empty="没有运行中的会话。">
        {detail.sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md border border-edge bg-base px-2.5 py-1.5">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs" title={s.title}>
                {s.title || s.name || s.id.slice(0, 8)}
              </div>
              <div className="text-[10px] text-dim">
                {s.sourceLabel} · 启动于 {fmtStartedAt(s.startedAt)}
              </div>
            </div>
          </div>
        ))}
      </Section>

      {/* 记忆 */}
      <Section title="记忆" empty={memoryNote ?? "还没有记忆文件。"}>
        {(memories ?? []).map((m) => (
          <div key={m.path} className="rounded-md border border-edge bg-base">
            <button
              onClick={() => void toggleMemory(m)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-card"
            >
              <span className="mono min-w-0 flex-1 truncate text-xs">{m.name}</span>
              <span className="shrink-0 text-[10px] text-dim">
                {openMemory?.path === m.path ? "收起" : "展开"}
              </span>
            </button>
            {openMemory?.path === m.path && (
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-edge px-2.5 py-2 text-xs leading-relaxed text-dim">
                {openMemory.text}
                {openMemory.truncated ? "\n…（内容过长，已截断）" : ""}
              </pre>
            )}
          </div>
        ))}
      </Section>

      {/* 定时任务 */}
      <Section title="定时任务" empty="没有绑定该专家的定时任务。">
        {detail.tasks.map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded-md border border-edge bg-base px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs">{t.name}</span>
                <span className="shrink-0 rounded border border-edge px-1 text-[9px] text-dim">{t.kind}</span>
                {!t.enabled && <span className="shrink-0 text-[9px] text-dim">已停用</span>}
                {t.lastResult === "error" && (
                  <span className="shrink-0 text-[9px] text-[var(--danger)]">上次失败</span>
                )}
              </div>
              <div className="mono truncate text-[10px] text-dim">
                {t.schedule}
                {t.enabled ? ` · 下次 ${fmtNextRun(t.nextRunAt)}` : ""}
              </div>
            </div>
          </div>
        ))}
      </Section>

      {/* 文件 */}
      <div className="rounded-lg border border-edge bg-card p-3">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-dim">文件</div>
        <button
          onClick={() =>
            void openPath(expert.workdir, false).catch((err) =>
              chatStore.pushToast(`打开目录失败：${errText(err)}`, "error"),
            )
          }
          className="rounded-md border border-edge px-3 py-1.5 text-xs text-dim hover:bg-base hover:text-ink"
        >
          打开工作目录
        </button>
      </div>
    </div>
  );
}

/** One detail block: section header + rows, or a one-line empty hint. */
function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode;
}) {
  const has = Array.isArray(children) ? children.length > 0 : children != null;
  return (
    <div className="rounded-lg border border-edge bg-card p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-dim">{title}</div>
      {has ? <div className="flex flex-col gap-1">{children}</div> : <p className="text-xs text-dim">{empty}</p>}
    </div>
  );
}
