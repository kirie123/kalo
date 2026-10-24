import { SKINS, type SkinPref, type ThemePref } from "../lib/appearance";

export const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export default function AppearanceSettings({ theme, skin, onThemeChange, onSkinChange }: {
  theme: ThemePref; skin: SkinPref; onThemeChange: (value: ThemePref) => void; onSkinChange: (value: SkinPref) => void;
}) {
  return <>
    <section className="appearance-section">
      <h2>界面皮肤</h2><p>同一套清昼布局，换一种适合自己的气质。</p>
      <div className="skin-options">{SKINS.map((option) => <button key={option.value} aria-pressed={skin === option.value} onClick={() => onSkinChange(option.value)}>
        <span className={`skin-preview skin-preview-${option.value}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span>
        <strong>{option.label}</strong><small>{option.description}</small>
      </button>)}</div>
    </section>
    <section className="appearance-section">
      <h2>明暗模式</h2><p>{skin === "night" ? "深航使用固定深色。此偏好会保留，切回其他皮肤时生效。" : "选择浅色、深色，或随系统自动变化。"}</p>
      <div className="appearance-modes">{THEME_OPTIONS.map((option) => <button key={option.value} aria-pressed={theme === option.value} onClick={() => onThemeChange(option.value)}>{option.label}</button>)}</div>
    </section>
  </>;
}
