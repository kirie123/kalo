import { useCallback, useEffect, useState } from "react";
import ChatView, { ExtensionModal, ToastContainer } from "./components/ChatView";
import EmptyState from "./components/EmptyState";
import FilePanel from "./components/FilePanel";
import SettingsPage, { applyTheme, loadTheme, type ThemePref } from "./components/SettingsPage";
import Sidebar from "./components/Sidebar";
import { listSessions } from "./lib/pi-bridge";
import { chatStore, useChatStore } from "./lib/chat-store";
import { loadWidth, startColumnDrag } from "./lib/drag";
import type { ProjectGroup } from "./types";

export default function App() {
  const chat = useChatStore();
  const [page, setPage] = useState<"chat" | "settings">("chat");
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
  // active session changes and when a run settles (new files appear).
  const refreshProjects = useCallback(() => {
    listSessions()
      .then(setProjects)
      .catch(() => {
        // Backend not ready yet (e.g. dev without Rust side) — keep empty.
      });
  }, []);
  useEffect(refreshProjects, [refreshProjects, chat.sessionId, chat.isStreaming]);

  // Custom providers from ~/.kalo/agent/models.json show up in the picker
  // immediately, without waiting for an engine session.
  useEffect(() => {
    void chatStore.loadCustomModels();
  }, []);

  const showEmpty = page === "chat" && chat.timeline.length === 0;

  return (
    <div className="flex h-screen overflow-hidden bg-base text-ink">
      <Sidebar
        collapsed={sidebarCollapsed}
        width={sidebarW}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        sessionGroups={projects}
        activeSessionId={chat.engineSessionId ?? null}
        onNewChat={() => {
          chatStore.newChat();
          setPage("chat");
        }}
        onSelectSession={(sessionPath, cwd) => {
          void chatStore.resumeSession(sessionPath, cwd);
          setPage("chat");
        }}
        onOpenSettings={() => setPage("settings")}
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
        {page === "settings" ? (
          <SettingsPage theme={theme} onThemeChange={setTheme} onBack={() => setPage("chat")} />
        ) : (
          <>
            {/* Slim header: cwd on the left, file-panel toggle on the right */}
            <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-edge px-4">
              <span className="mono truncate text-xs text-dim" title={chat.cwd || undefined}>
                {chat.cwd || "未选择目录"}
              </span>
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
            </header>

            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {showEmpty ? <EmptyState /> : <ChatView />}
              </div>
              {panelOpen && <FilePanel />}
            </div>
          </>
        )}
      </main>

      <ToastContainer />
      <ExtensionModal />
    </div>
  );
}
