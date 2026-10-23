import AppIcon, { type IconName } from "./AppIcon";

export type AppPage = "chat" | "settings" | "era" | "notes" | "automation" | "experts";

const items: Array<{ page: AppPage; icon: IconName; label: string }> = [
  { page: "chat", icon: "home", label: "对话" },
  { page: "notes", icon: "note", label: "笔记" },
  { page: "automation", icon: "clock", label: "自动化" },
  { page: "experts", icon: "users", label: "数字专家" },
  { page: "era", icon: "sprout", label: "演化" },
];

export default function NavigationRail({ page, onNavigate }: { page: AppPage; onNavigate: (page: AppPage) => void }) {
  return <nav className="navigation-rail" aria-label="主导航">
    {items.map((item, index) => <div key={item.page} className={index === 2 ? "rail-group-start" : undefined}>
      <button title={item.label} aria-label={item.label} aria-current={page === item.page ? "page" : undefined} onClick={() => onNavigate(item.page)}>
        <AppIcon name={item.icon} size={20} />
      </button>
    </div>)}
    <button className="rail-settings" title="设置" aria-label="设置" aria-current={page === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><AppIcon name="settings" size={20} /></button>
    <span className="rail-avatar" title="本地工作空间">K</span>
  </nav>;
}
