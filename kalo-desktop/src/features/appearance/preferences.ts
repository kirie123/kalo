import { appearanceIsDark, parseSkin, parseTheme, type SkinPref, type ThemePref } from "../../lib/appearance";

export function loadTheme(): ThemePref {
  return parseTheme(localStorage.getItem("kalo.theme"));
}

export function loadSkin(): SkinPref {
  return parseSkin(localStorage.getItem("kalo.skin"));
}

export function applyAppearance(theme: ThemePref, skin: SkinPref) {
  const dark = appearanceIsDark(theme, skin, window.matchMedia("(prefers-color-scheme: dark)").matches);
  // Set the skin before the class mutation so existing theme observers see a coherent palette.
  document.documentElement.dataset.skin = skin;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
