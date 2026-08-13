import { useState, type ReactNode } from "react";
import { chatStore } from "../lib/chat-store";
import { cwdBasename, listProjects, normalizeCwd, removeProject, type ProjectEntry } from "../lib/projects";
import type { ProjectGroup, SessionSummary } from "../types";
import NewProjectModal from "./NewProjectModal";

interface SidebarProps {
  collapsed: boolean;
  /** Pixel width when expanded (draggable via the app-level splitter). */
  width?: number;
  onToggleCollapsed: () => void;
  /** Session history grouped by cwd, straight from list_sessions. */
  sessionGroups: ProjectGroup[];
  activeSessionId: string | null;
  onNewChat: () => void;
  onSelectSession: (sessionPath: string, cwd: string) => void;
  onOpenSettings: () => void;
}

/** "2 天" / "3 小时" / "刚刚" style relative time. */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月`;
  return `${Math.floor(months / 12)} 年`;
}

function notImplemented() {
  chatStore.pushToast("该功能暂未实现", "info");
}

export default function Sidebar({
  collapsed,
  width,
  onToggleCollapsed,
  sessionGroups,
  activeSessionId,
  onNewChat,
  onSelectSession,
  onOpenSettings,
}: SidebarProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>(() => listProjects());
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);

  const reloadProjects = () => setProjects(listProjects());

  const sessionsOf = (cwd: string): SessionSummary[] =>
    sessionGroups.find((g) => normalizeCwd(g.cwd) === normalizeCwd(cwd))?.sessions ?? [];

  // Flat history across all projects, newest first.
  const allSessions = sessionGroups
    .flatMap((g) => g.sessions.map((s) => ({ ...s, cwd: g.cwd })))
    .sort((a, b) => b.modifiedMs - a.modifiedMs);

  // Clicking a project starts a fresh chat in its directory.
  const openProject = (cwd: string) => {
    onNewChat();
    void chatStore.setCwd(cwd);
  };

  if (collapsed) {
    return (
      <div className="flex w-12 flex-col items-center border-r border-edge bg-sidebar py-3">
        <button
          onClick={onToggleCollapsed}
          title="展开侧边栏"
          className="rounded-md p-2 text-dim hover:bg-card hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onNewChat}
          title="新对话"
          className="mt-2 rounded-md p-2 text-dim hover:bg-card hover:text-ink"
        >
          <PencilIcon />
        </button>
      </div>
    );
  }

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-edge bg-sidebar"
      style={width ? { width } : undefined}
    >
      {/* Top actions */}
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="px-1 text-sm font-semibold">Kalo</span>
        <button
          onClick={onToggleCollapsed}
          title="折叠侧边栏"
          className="rounded-md p-1.5 text-dim hover:bg-card hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex flex-col gap-0.5 px-2">
        <SideButton onClick={onNewChat} icon={<PencilIcon />} label="新对话" />
        <SideButton onClick={notImplemented} icon={<SearchIcon />} label="搜索" />
        <SideButton onClick={notImplemented} icon={<PuzzleIcon />} label="插件" />
      </div>

      {/* Projects + chats share one scroll area */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex items-center justify-between px-2 pb-1">
          <button
            onClick={() => setProjectsOpen((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-dim hover:text-ink"
          >
            <ChevronIcon open={projectsOpen} />
            项目
          </button>
          <button
            onClick={() => setShowNewProject(true)}
            title="添加项目"
            className="rounded p-0.5 text-dim hover:bg-card hover:text-ink"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {projectsOpen && (
          <>
            {projects.length === 0 && <div className="px-2 py-1 text-xs text-dim">暂无项目，点击 + 添加</div>}
            {projects.map((p) => (
              <ProjectRow
                key={p.cwd}
                project={p}
                sessions={sessionsOf(p.cwd)}
                activeSessionId={activeSessionId}
                onOpen={() => openProject(p.cwd)}
                onRemove={() => {
                  removeProject(p.cwd);
                  reloadProjects();
                }}
                onSelectSession={onSelectSession}
              />
            ))}
          </>
        )}

        <div className="mt-4 px-2 pb-1">
          <button
            onClick={() => setChatsOpen((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-dim hover:text-ink"
          >
            <ChevronIcon open={chatsOpen} />
            聊天
          </button>
        </div>
        {chatsOpen && (
          <>
            {allSessions.length === 0 && <div className="px-2 py-1 text-xs text-dim">暂无历史会话</div>}
            {allSessions.map((s) => (
              <button
                key={s.path}
                onClick={() => onSelectSession(s.path, s.cwd)}
                title={s.title || "未命名会话"}
                className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-card ${
                  activeSessionId && s.id === activeSessionId ? "bg-card" : ""
                }`}
              >
                <span className="w-full truncate text-sm">{s.title || "未命名会话"}</span>
                <span className="w-full truncate text-xs text-dim">
                  {cwdBasename(s.cwd)} · {formatRelativeTime(s.modifiedMs)}
                </span>
              </button>
            ))}
          </>
        )}
      </div>

      {/* Bottom */}
      <div className="border-t border-edge px-2 py-2">
        <SideButton onClick={onOpenSettings} icon={<GearIcon />} label="设置" />
      </div>

      {showNewProject && (
        <NewProjectModal
          onClose={(added) => {
            setShowNewProject(false);
            if (added) reloadProjects();
          }}
        />
      )}
    </aside>
  );
}

function ProjectRow({
  project,
  sessions,
  activeSessionId,
  onOpen,
  onRemove,
  onSelectSession,
}: {
  project: ProjectEntry;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onOpen: () => void;
  onRemove: () => void;
  onSelectSession: (sessionPath: string, cwd: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <div className="group flex w-full items-center gap-1 rounded-md px-1 py-1 hover:bg-card">
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? "收起会话" : "展开会话"}
          className="shrink-0 rounded p-1 text-dim hover:text-ink"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onOpen}
          title={`${project.cwd}（点击在此开新对话）`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm"
        >
          <FolderIcon />
          <span className="truncate">{project.name}</span>
        </button>
        <button
          onClick={onRemove}
          title="移除项目（不删除会话）"
          className="hidden shrink-0 rounded p-1 text-dim hover:text-[var(--danger)] group-hover:block"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {open && sessions.length === 0 && <div className="py-1 pl-9 text-xs text-dim">暂无会话</div>}
      {open &&
        sessions.map((s) => (
          <button
            key={s.path}
            onClick={() => onSelectSession(s.path, project.cwd)}
            title={s.title || "未命名会话"}
            className={`flex w-full items-baseline justify-between gap-2 rounded-md py-1.5 pl-9 pr-2 text-left text-sm hover:bg-card ${
              activeSessionId && s.id === activeSessionId ? "bg-card" : ""
            }`}
          >
            <span className="truncate">{s.title || "未命名会话"}</span>
            <span className="shrink-0 text-xs text-dim">{formatRelativeTime(s.modifiedMs)}</span>
          </button>
        ))}
    </div>
  );
}

function SideButton({ onClick, icon, label }: { onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-card"
    >
      <span className="text-dim">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/** Small down/right chevron used by collapsible section headers. */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
    >
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-dim">
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2l1.5 2h5.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path
        d="M11.3 2.3a1.4 1.4 0 012 0l.4.4a1.4 1.4 0 010 2L6 12.4 3 13l.6-3L11.3 2.3z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  );
}

function PuzzleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 8h3M10.5 8h3M8 2.5v3M8 10.5v3" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.2" />
      <path
        d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
