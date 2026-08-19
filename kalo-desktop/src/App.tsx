import { useCallback, useEffect, useRef, useState } from "react";
import ChatView, { ExtensionModal, ToastContainer } from "./components/ChatView";
import EmptyState from "./components/EmptyState";
import EraPanel from "./features/era/EraPanel";
import FilePanel from "./components/FilePanel";
import JobsCenter from "./components/JobsCenter";
import SettingsPage, { applyTheme, loadTheme, type SettingsTab, type ThemePref } from "./components/SettingsPage";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
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
  const [page, setPage] = useState<"chat" | "settings" | "era">("chat");
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
  const onOpenSettings = useCallback(() => {
    setSettingsTab(undefined);
    setPage("settings");
  }, []);
  // 「自动化」lands directly on the 定时任务 panel.
  const onOpenAutomation = useCallback(() => {
    setSettingsTab("tasks");
    setPage("settings");
  }, []);
  // 「演化」takes over the main pane, keeping the sidebar: a run is watched
  // for a long time, and handing a spec back to a chat session is one click.
  const onOpenEra = useCallback(() => setPage("era"), []);

  const showEmpty = page === "chat" && !chat.hasMessages;

  // Title-bar caption: whichever page is up, then the engine's session name,
  // falling back to the working directory's basename.
  const barTitle =
    page === "settings"
      ? "设置"
      : page === "era"
        ? "演化"
        : chat.sessionName || cwdBasename(chat.cwd) || "Kalo";

  // Settings takes over the whole window — no session sidebar next to it.
  if (page === "settings") {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-base text-ink">
        <TitleBar title={barTitle} />
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
      <TitleBar title={barTitle} />
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
          onOpenEra={onOpenEra}
          eraActive={page === "era"}
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
              {page === "era" ? "演化" : chat.cwd || "未选择目录"}
            </span>
            <div className="flex items-center gap-1">
              <JobsCenter />
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
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {page === "era" ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                  <EraPanel onLeaveToChat={() => setPage("chat")} />
                </div>
              ) : showEmpty ? (
                <EmptyState />
              ) : (
                <ChatView />
              )}
            </div>
            {panelOpen && page !== "era" && <FilePanel />}
          </div>
        </main>
      </div>

      <ToastContainer />
      <ExtensionModal />
    </div>
  );
}
