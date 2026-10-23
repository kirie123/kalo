export type ThemePref = "system" | "light" | "dark";
export type SkinPref = "clear" | "paper" | "night";

export function parseTheme(value: string | null): ThemePref {
  return value === "light" || value === "dark" ? value : "system";
}

export function parseSkin(value: string | null): SkinPref {
  return value === "paper" || value === "night" ? value : "clear";
}

export function appearanceIsDark(theme: ThemePref, skin: SkinPref, systemDark: boolean): boolean {
  return skin === "night" || theme === "dark" || (theme === "system" && systemDark);
}

export const SKINS: Array<{ value: SkinPref; label: string; description: string }> = [
  { value: "clear", label: "清昼", description: "中性灰阶，清爽而克制" },
  { value: "paper", label: "纸间", description: "纸张底色，鼠尾草绿与书写感" },
  { value: "night", label: "深航", description: "墨蓝与薄荷绿，专注于内容" },
];
