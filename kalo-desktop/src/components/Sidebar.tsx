import { memo, useState, type ReactNode } from "react";
import { chatStore } from "../lib/chat-store";
import { cwdBasename, listProjects, normalizeCwd, removeProject, type ProjectEntry } from "../lib/projects";
import { mergeSessionRows, SESSION_PAGE_SIZE, visibleRows, type SessionRow } from "../lib/session-rows";
import type { PendingSession, ProjectGroup, SessionSummary } from "../types";
import ContextMenu, { copyPathItem, openPathItem, useContextMenu, type MenuItem } from "./ContextMenu";
import NewProjectModal from "./NewProjectModal";

interface SidebarProps {
  collapsed: boolean;
  /** Pixel width when expanded (draggable via the app-level splitter). */
  width?: number;
  onToggleCollapsed: () => void;
  /** Session history grouped by cwd, straight from list_sessions. */
  sessionGroups: ProjectGroup[];
  /** Sessions started but not yet on disk; merged into the lists below. */
  pendingSessions: PendingSession[];
  activeSessionId: string | null;
  /** Engine-pool flags: session files (normalized) with a run in flight. */
  runningByFile: Record<string, boolean>;
  onNewChat: () => void;
  onSelectSession: (sessionPath: string, cwd: string) => void;
  /** Delete one session's history file (confirmed in the menu already). */
  onDeleteSession: (session: SessionSummary) => void;
  /** Rename one session's title (live sessions via the engine, others on disk). */
  onRenameSession: (session: SessionSummary, name: string) => void;
  /** 「自动化」— takes over the main pane with the 定时任务 table. */
  onOpenAutomation: () => void;
  /** True while the automation page is the current page. */
  automationActive?: boolean;
  /** 「演化」— takes over the main pane with the era panel. */
  onOpenEra: () => void;
  /** True while the era panel is the current page, so the button reads as selected. */
  eraActive?: boolean;
  /** 「知识笔记」— takes over the main pane with the notes workspace. */
  onOpenNotes: () => void;
  /** True while the notes panel is the current page. */
  notesActive?: boolean;
  onOpenSettings: () => void;
}

/** Same normalization as chat-store's normPath (pool keys). */
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Spinning arc shown next to sessions whose engine has a run in flight. */
function RunningSpinner() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth="2"
      className="shrink-0 animate-spin text-[var(--accent,#4b9eff)]"
      aria-label="运行中"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" opacity="0.2" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
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

/**
 * Memoized: App re-renders whenever the chat shell's fields change, but the
 * sidebar only depends on the session list, the active id and the run flags.
 * Its callbacks are stabilized with useCallback on the App side.
 */
export default memo(function Sidebar({
  collapsed,
  width,
  onToggleCollapsed,
  sessionGroups,
  pendingSessions,
  activeSessionId,
  runningByFile,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onOpenAutomation,
  automationActive,
  onOpenEra,
  eraActive,
  onOpenNotes,
  notesActive,
  onOpenSettings,
}: SidebarProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>(() => listProjects());
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  // How many rows the flat 聊天 list renders; grows by a page per「显示更多」.
  const [chatLimit, setChatLimit] = useState(SESSION_PAGE_SIZE);
  // Which session row is showing its inline rename input (path + prefilled title).
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);

  const startRename = (s: SessionRow) => setRenaming({ path: s.path, value: s.title || "" });
  const cancelRename = () => setRenaming(null);
  const commitRename = (s: SessionRow, raw: string) => {
    const value = raw.trim();
    setRenaming(null);
    const current = (s.title || "").trim();
    if (!value || value === current) return;
    onRenameSession(s, value);
  };

  const reloadProjects = () => setProjects(listProjects());

  const isRunning = (path: string) => runningByFile[normPath(path)] === true;

  // Rows that must stay visible even past the limit: the open session and any
  // session with a run in flight (its spinner is the point), plus the row
  // currently being renamed (its input would otherwise vanish mid-edit).
  const mustShow = (row: SessionRow) =>
    (activeSessionId !== null && row.id === activeSessionId) ||
    row.pending === true ||
    isRunning(row.path) ||
    renaming?.path === row.path;

  // Every row, on-disk and optimistic, newest first.
  const allRows = mergeSessionRows(sessionGroups, pendingSessions);

  const sessionsOf = (cwd: string): SessionRow[] =>
    allRows.filter((s) => normalizeCwd(s.cwd) === normalizeCwd(cwd));

  // Flat history, newest first. Sessions under a pinned project live in that
  // project's row, so they're excluded here to avoid showing up twice.
  const projectCwds = new Set(projects.map((p) => normalizeCwd(p.cwd)));
  const looseSessions = allRows
    .filter((s) => !projectCwds.has(normalizeCwd(s.cwd)))
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
  const looseVisible = visibleRows(looseSessions, chatLimit, mustShow);
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
      {/* Top row — wordmark, left-aligned with the nav items' icon column. */}
      <div className="flex items-center justify-between pl-4 pr-3 pt-2">
        <span className="select-none text-base font-semibold tracking-tight text-ink">Kalo</span>
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
        <SideButton onClick={onOpenAutomation} icon={<ClockIcon />} label="自动化" active={automationActive} />
        <SideButton onClick={onOpenNotes} icon={<BookIcon />} label="知识笔记" active={notesActive} />
        <SideButton onClick={onOpenEra} icon={<EvolveIcon />} label="演化" active={eraActive} />
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
                isRunning={isRunning}
                mustShow={mustShow}
                onNewSession={() => openProject(p.cwd)}
                onRemove={() => {
                  removeProject(p.cwd);
                  reloadProjects();
                }}
                onSelectSession={onSelectSession}
                onDeleteSession={onDeleteSession}
                renaming={renaming}
                onStartRename={startRename}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
              />
            ))}
          </>
        )}

        <div className="mt-4 px-2 pb-1">
          <button
            onClick={() =>
              setChatsOpen((v) => {
                // Collapsing resets the page, so reopening starts at 10 again.
                if (v) setChatLimit(SESSION_PAGE_SIZE);
                return !v;
              })
            }
            className="flex items-center gap-1 text-xs font-medium text-dim hover:text-ink"
          >
            <ChevronIcon open={chatsOpen} />
            聊天
          </button>
        </div>
        {chatsOpen && (
          <>
            {looseSessions.length === 0 && <div className="px-2 py-1 text-xs text-dim">暂无历史会话</div>}
            {looseVisible.map((s) => (
              <SessionRowItem
                key={s.path}
                session={s}
                variant="flat"
                active={activeSessionId !== null && s.id === activeSessionId}
                running={isRunning(s.path)}
                renaming={renaming}
                onStartRename={startRename}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onSelect={() => onSelectSession(s.path, s.cwd)}
                onDelete={onDeleteSession}
              />
            ))}
            {looseSessions.length > chatLimit && (
              <ShowMoreButton
                remaining={looseSessions.length - chatLimit}
                onClick={() => setChatLimit((n) => n + SESSION_PAGE_SIZE)}
              />
            )}
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
});

function ProjectRow({
  project,
  sessions,
  activeSessionId,
  isRunning,
  mustShow,
  onNewSession,
  onRemove,
  onSelectSession,
  onDeleteSession,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  project: ProjectEntry;
  sessions: SessionRow[];
  activeSessionId: string | null;
  isRunning: (path: string) => boolean;
  /** Rows the pagination must keep visible (active / running / optimistic). */
  mustShow: (row: SessionRow) => boolean;
  /** 「+」— starts a fresh chat in this project without collapsing its list. */
  onNewSession: () => void;
  onRemove: () => void;
  onSelectSession: (sessionPath: string, cwd: string) => void;
  onDeleteSession: (session: SessionSummary) => void;
  /** Inline-rename editor state + handlers, threaded from the sidebar. */
  renaming: { path: string; value: string } | null;
  onStartRename: (session: SessionRow) => void;
  onCommitRename: (session: SessionRow, value: string) => void;
  onCancelRename: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Per-project page counter, reset whenever the row is collapsed.
  const [limit, setLimit] = useState(SESSION_PAGE_SIZE);
  const visible = visibleRows(sessions, limit, mustShow);
  const toggleOpen = () =>
    setOpen((v) => {
      if (v) setLimit(SESSION_PAGE_SIZE);
      return !v;
    });
  return (
    <div className="mb-1">
      <div className="group flex w-full items-center gap-1 rounded-md px-1 py-1 hover:bg-card">
        {/* Clicking the row toggles its session list; 「+」 is what starts a chat. */}
        <button
          onClick={toggleOpen}
          title={`${project.cwd}（点击${open ? "收起" : "展开"}会话）`}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-sm"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <FolderIcon />
          <span className="truncate">{project.name}</span>
        </button>
        <button
          onClick={() => {
            // Show the list so the new chat's optimistic row is visible.
            setOpen(true);
            onNewSession();
          }}
          title={`在「${project.name}」下新建会话`}
          className="hidden shrink-0 rounded p-1 text-dim hover:text-ink group-hover:block"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
          </svg>
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
        visible.map((s) => (
          <SessionRowItem
            key={s.path}
            session={s}
            variant="project"
            active={activeSessionId !== null && s.id === activeSessionId}
            running={isRunning(s.path)}
            renaming={renaming}
            onStartRename={onStartRename}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onSelect={() => onSelectSession(s.path, project.cwd)}
            onDelete={onDeleteSession}
          />
        ))}
      {open && sessions.length > limit && (
        <ShowMoreButton
          remaining={sessions.length - limit}
          indent
          onClick={() => setLimit((n) => n + SESSION_PAGE_SIZE)}
        />
      )}
    </div>
  );
}

/** 「显示更多」— renders one more page of session rows. */
function ShowMoreButton({
  remaining,
  indent,
  onClick,
}: {
  remaining: number;
  /** Inside a project row: line up with the indented session rows. */
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-md py-1.5 text-left text-xs text-dim hover:bg-card hover:text-ink ${
        indent ? "pl-9 pr-2" : "px-2"
      }`}
    >
      显示更多（剩余 {remaining}）
    </button>
  );
}

/**
 * One sidebar session row. `flat` (聊天 section) stacks the title over the
 * project·time line; `project` (under a project) puts the title on the left
 * and the relative time on the right. While `renaming` matches this row,
 * the title is replaced by an inline input (Enter commits, Esc cancels,
 * blur commits).
 *
 * Right-clicking the row and clicking the「...」button open the same menu.
 */
function SessionRowItem({
  session,
  variant,
  active,
  running,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onSelect,
  onDelete,
}: {
  session: SessionRow;
  variant: "flat" | "project";
  active: boolean;
  running: boolean;
  /** Sidebar-level rename editor state; null when no row is being renamed. */
  renaming: { path: string; value: string } | null;
  onStartRename: (session: SessionRow) => void;
  onCommitRename: (session: SessionRow, value: string) => void;
  onCancelRename: () => void;
  onSelect: () => void;
  onDelete: (session: SessionSummary) => void;
}) {
  const editing = renaming?.path === session.path;
  const menu = useContextMenu();

  // One list for both entry points, so they can't drift apart.
  const items: MenuItem[] = [
    { label: "重命名", action: () => onStartRename(session) },
    openPathItem("打开项目文件夹", session.cwd, true),
    copyPathItem(session.cwd, "复制项目路径"),
    // Optimistic rows have no file on disk to delete yet.
    ...(session.pending
      ? []
      : [
          {
            label: "删除会话",
            danger: true,
            action: () => {
              if (window.confirm(`确定删除会话「${session.title || "未命名会话"}」的历史记录？该操作不可恢复。`)) {
                onDelete(session);
              }
            },
          },
        ]),
  ];

  return (
    <div
      // While the inline input is open, leave right-click to the browser so the
      // menu can't steal the blur that commits the rename.
      onContextMenu={editing ? undefined : menu.onContextMenu}
      className={`group flex w-full items-center gap-1 rounded-md hover:bg-card ${
        variant === "flat" ? "px-2 py-1.5" : "py-1.5 pl-9 pr-2"
      } ${active ? "bg-card" : ""}`}
    >
      {running && <RunningSpinner />}
      {editing ? (
        <input
          autoFocus
          defaultValue={renaming?.value ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(session, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") onCancelRename();
          }}
          onBlur={(e) => onCommitRename(session, (e.target as HTMLInputElement).value)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded border border-edge bg-base px-1.5 py-0.5 text-sm outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <button
          onClick={onSelect}
          title={session.title || "未命名会话"}
          className={`flex min-w-0 flex-1 text-left text-sm ${
            variant === "flat" ? "flex-col" : "items-baseline justify-between gap-2"
          }`}
        >
          <span className={variant === "flat" ? "w-full truncate" : "truncate"}>
            {session.title || "未命名会话"}
          </span>
          {variant === "flat" ? (
            <span className="w-full truncate text-xs text-dim">
              {cwdBasename(session.cwd)} · {formatRelativeTime(session.modifiedMs)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-dim">{formatRelativeTime(session.modifiedMs)}</span>
          )}
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          menu.openAtRect(e.currentTarget);
        }}
        title="更多操作（也可右键该会话）"
        className={`shrink-0 rounded p-1 text-dim hover:text-ink ${
          menu.at ? "block" : "hidden group-hover:block"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {menu.at && <ContextMenu at={menu.at} items={items} onClose={menu.close} />}
    </div>
  );
}

function SideButton({
  onClick,
  icon,
  label,
  active,
}: {
  onClick: () => void;
  icon: ReactNode;
  label: string;
  /** Pages that stay open (演化) mark themselves; one-shot actions don't. */
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-card ${
        active ? "bg-card" : ""
      }`}
    >
      <span className={active ? "text-ink" : "text-dim"}>{icon}</span>
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

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A rising staircase: repeated improvement, one step per generation. */
function EvolveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 13h3v-3h3V7h3V4h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** An open book: the knowledge library. */
function BookIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M8 4.2S6.8 3 4.6 3H2v9h2.6C6.8 12 8 13 8 13s1.2-1 3.4-1H14V3h-2.6C9.2 3 8 4.2 8 4.2z" strokeLinejoin="round" />
      <path d="M8 4.2V13" />
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
