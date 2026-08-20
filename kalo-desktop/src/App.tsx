import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ChatView, { ExtensionModal, ToastContainer } from "./components/ChatView";
import EmptyState from "./components/EmptyState";
import EraPanel from "./features/era/EraPanel";
import FeedsSettings from "./components/FeedsSettings";
import FilePanel from "./components/FilePanel";
import JobsCenter from "./components/JobsCenter";
import NotesPanel from "./features/notes/NotesPanel";
import SettingsPage, {
  applyTheme,
  loadTheme,
  THEME_OPTIONS,
  type SettingsTab,
  type ThemePref,
} from "./components/SettingsPage";
import Sidebar from "./components/Sidebar";
import TasksSettings from "./components/TasksSettings";
import TitleBar, { type MenuEntry, type TitleMenu } from "./components/TitleBar";
import { listSessions, deleteSession } from "./lib/pi-bridge";
import { chatStore, useChatSelector } from "./lib/chat-store";
import { loadWidth, startColumnDrag } from "./lib/drag";
import { cwdBasename } from "./lib/projects";
import type { ProjectGroup, SessionSummary } from "./types";

export default function App() {
  // Field-level subscription: the store commits ~20fps while streaming, and
  // the shell only cares about these few values (never the timeline itself).
  const chat = useChatSelector((s) => ({
    cwd: s.cwd,
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    engineSessionId: s.engineSessionId,
    isStreaming: s.isStreaming,
    runningByFile: s.runningByFile,
    pendingSessions: s.pendingSessions,
    hasMessages: s.timeline.length > 0,
  }));
  const [page, setPage] = useState<"chat" | "settings" | "era" | "notes" | "automation">("chat");
  // undefined → SettingsPage restores the last visited tab.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarW, setSidebarW] = useState(() => loadWidth("kalo.layout.sidebarW", 260));
  const [panelOpen, setPanelOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme());

  // Apply theme to <html>; in "system" mode also follow OS changes.
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("kalo.theme", theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Project/session list for the sidebar; refreshed on mount, when the
  // active session changes, when a run settles (new files appear) and when
  // any pooled run (including background ones) starts or ends.
  const refreshProjects = useCallback(() => {
    listSessions()
      .then((groups) => {
        setProjects(groups);
        // Retire optimistic rows whose file the scan can now see.
        chatStore.notePersistedSessions(groups.flatMap((g) => g.sessions.map((s) => s.path)));
      })
      .catch(() => {
        // Backend not ready yet (e.g. dev without Rust side) — keep empty.
      });
  }, []);

  // Debounced: the triggers below can flip several times in a row (a run
  // starting flips isStreaming and runningByFile), and each refresh is a
  // full scan of the sessions directory.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refreshProjects, 300);
  }, [refreshProjects]);

  const runningCount = Object.keys(chat.runningByFile).length;
  useEffect(() => {
    scheduleRefresh();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [scheduleRefresh, chat.sessionId, chat.isStreaming, runningCount]);

  // While an optimistic row is up, the real file lands at the first assistant
  // message — an event the triggers above do not cover. Poll until the scan
  // picks it up, so the row is swapped for the real entry (title + timestamp)
  // without waiting for the whole run to settle.
  const pendingCount = chat.pendingSessions.length;
  useEffect(() => {
    if (pendingCount === 0) return;
    const t = setInterval(refreshProjects, 2000);
    return () => clearInterval(t);
  }, [pendingCount, refreshProjects]);

  // Custom providers from ~/.kalo/agent/models.json show up in the picker
  // immediately, without waiting for an engine session.
  useEffect(() => {
    void chatStore.loadCustomModels();
  }, []);

  // Stable callbacks so the memoized Sidebar actually skips re-renders.
  const onToggleCollapsed = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const onNewChat = useCallback(() => {
    chatStore.newChat();
    setPage("chat");
  }, []);
  const onSelectSession = useCallback((sessionPath: string, cwd: string) => {
    void chatStore.resumeSession(sessionPath, cwd);
    setPage("chat");
  }, []);
  const onDeleteSession = useCallback(
    (s: SessionSummary) => {
      void (async () => {
        // Tear down the pooled runtime bound to this file first (kills
        // its engine, switches away if it is the active view), so the
        // engine can't rewrite the file after deletion.
        await chatStore.closeSessionFile(s.path);
        try {
          await deleteSession(s.path);
          refreshProjects();
        } catch (err) {
          chatStore.pushToast(`删除会话失败：${err instanceof Error ? err.message : String(err)}`, "error");
        }
      })();
    },
    [refreshProjects],
  );
  const onOpenSettings = useCallback((tab?: SettingsTab) => {
    setSettingsTab(tab);
    setPage("settings");
  }, []);
  // 「自动化」is the 定时任务 table on its own main-pane page — opening the
  // whole settings window for it read as too abrupt.
  const onOpenAutomation = useCallback(() => setPage("automation"), []);
  // 「演化」takes over the main pane, keeping the sidebar: a run is watched
  // for a long time, and handing a spec back to a chat session is one click.
  const onOpenEra = useCallback(() => setPage("era"), []);
  // 「知识笔记」is a full main-pane workspace of its own (three columns), so
  // it takes the pane the same way 演化 does rather than opening a modal.
  const onOpenNotes = useCallback(() => setPage("notes"), []);

  // 文件 → 选择工作目录…: same picker as the composer's cwd button.
  const pickCwd = useCallback(() => {
    void (async () => {
      try {
        const dir = await open({ directory: true });
        if (typeof dir === "string") {
          await chatStore.setCwd(dir);
          setPage("chat");
        }
      } catch (err) {
        chatStore.pushToast(`选择目录失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    })();
  }, []);

  // App menus (rendered by TitleBar). Every entry is an action that already
  // exists elsewhere in the UI — the bar is a second, discoverable route to it.
  const menus: TitleMenu[] = useMemo(
    () => [
      {
        label: "文件",
        entries: [
          { kind: "item", label: "新对话", onClick: onNewChat },
          { kind: "item", label: "选择工作目录…", onClick: pickCwd },
          { kind: "sep" },
          { kind: "item", label: "设置", onClick: () => onOpenSettings() },
          {
            kind: "item",
            label: "退出",
            onClick: () => {
              try {
                void getCurrentWindow().close();
              } catch {
                // Plain browser (vite dev): nothing to close.
              }
            },
          },
        ],
      },
      {
        label: "视图",
        entries: [
          { kind: "item", label: "侧边栏", checked: !sidebarCollapsed, onClick: onToggleCollapsed },
          {
            kind: "item",
            label: "文件面板",
            checked: panelOpen && page === "chat",
            disabled: page !== "chat",
            onClick: () => setPanelOpen((v) => !v),
          },
          { kind: "sep" },
          { kind: "item", label: "聊天", checked: page === "chat", onClick: () => setPage("chat") },
          { kind: "item", label: "自动化", checked: page === "automation", onClick: onOpenAutomation },
          { kind: "item", label: "知识笔记", checked: page === "notes", onClick: onOpenNotes },
          { kind: "item", label: "演化", checked: page === "era", onClick: onOpenEra },
          { kind: "sep" },
          ...THEME_OPTIONS.map(
            (t): MenuEntry => ({
              kind: "item",
              label: t.label,
              checked: theme === t.value,
              onClick: () => setTheme(t.value),
            }),
          ),
        ],
      },
      {
        label: "帮助",
        entries: [
          { kind: "item", label: "技能与内置技能", onClick: () => onOpenSettings("skills") },
          { kind: "item", label: "关于 Kalo", onClick: () => onOpenSettings("about") },
        ],
      },
    ],
    [
      onNewChat,
      pickCwd,
      onOpenSettings,
      onToggleCollapsed,
      sidebarCollapsed,
      panelOpen,
      page,
      onOpenAutomation,
      onOpenNotes,
      onOpenEra,
      theme,
    ],
  );

  const showEmpty = page === "chat" && !chat.hasMessages;

  // Title-bar caption: whichever page is up, then the engine's session name,
  // falling back to the working directory's basename.
  const barTitle =
    page === "settings"
      ? "设置"
      : page === "era"
        ? "演化"
        : page === "notes"
          ? "知识笔记"
          : page === "automation"
            ? "自动化"
            : chat.sessionName || cwdBasename(chat.cwd) || "Kalo";

  // Settings takes over the whole window — no session sidebar next to it.
  if (page === "settings") {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-base text-ink">
        <TitleBar title={barTitle} menus={menus} onOpenFeeds={onOpenAutomation} />
        <div className="flex min-h-0 flex-1">
          <SettingsPage
            theme={theme}
            onThemeChange={setTheme}
            onBack={() => setPage("chat")}
            initialTab={settingsTab}
          />
        </div>
        <ToastContainer />
        <ExtensionModal />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-base text-ink">
      <TitleBar title={barTitle} menus={menus} onOpenFeeds={onOpenAutomation} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          collapsed={sidebarCollapsed}
          width={sidebarW}
          onToggleCollapsed={onToggleCollapsed}
          sessionGroups={projects}
          pendingSessions={chat.pendingSessions}
          activeSessionId={chat.engineSessionId ?? null}
          runningByFile={chat.runningByFile}
          onNewChat={onNewChat}
          onSelectSession={onSelectSession}
          onDeleteSession={onDeleteSession}
          onOpenAutomation={onOpenAutomation}
          automationActive={page === "automation"}
          onOpenEra={onOpenEra}
          eraActive={page === "era"}
          onOpenNotes={onOpenNotes}
          notesActive={page === "notes"}
          onOpenSettings={onOpenSettings}
        />

        {/* Sidebar splitter */}
        {!sidebarCollapsed && (
          <div
            onMouseDown={(e) =>
              startColumnDrag(e, sidebarW, { min: 200, max: 480, persistKey: "kalo.layout.sidebarW" }, setSidebarW)
            }
            className="w-1 shrink-0 cursor-col-resize hover:bg-edge"
          />
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {/* Slim header: cwd on the left, file-panel toggle on the right */}
          <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-edge px-4">
            <span className="mono truncate text-xs text-dim" title={chat.cwd || undefined}>
              {page === "era" ? "演化" : page === "notes" ? "知识笔记 · ~/.kalo/knowledge" : page === "automation" ? "自动化 · 定时任务与数据源" : chat.cwd || "未选择目录"}
            </span>
            <div className="flex items-center gap-1">
              <JobsCenter />
              {/* The file panel is bound to the chat's cwd; the other pages
                  have no cwd of their own, so the toggle is hidden there. */}
              {page === "chat" && (
                <button
                  onClick={() => setPanelOpen((v) => !v)}
                  title="文件面板"
                  className={`shrink-0 rounded-md p-1.5 hover:bg-card ${
                    panelOpen ? "text-ink" : "text-dim hover:text-ink"
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <path d="M9.5 3v10" />
                  </svg>
                </button>
              )}
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {page === "era" ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                  <EraPanel onLeaveToChat={() => setPage("chat")} />
                </div>
              ) : page === "notes" ? (
                <NotesPanel />
              ) : page === "automation" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-2xl px-6 py-6">
                    <TasksSettings />
                    <FeedsSettings />
                  </div>
                </div>
              ) : showEmpty ? (
                <EmptyState />
              ) : (
                <ChatView />
              )}
            </div>
            {panelOpen && page === "chat" && <FilePanel />}
          </div>
        </main>
      </div>

      <ToastContainer />
      <ExtensionModal />
    </div>
  );
}
