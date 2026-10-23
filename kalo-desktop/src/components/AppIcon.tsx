import type { ReactNode } from "react";

const glyphs = {
  home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h5v-6h4v6h5V9" /></>,
  note: <><path d="M13 4H6a2 2 0 0 0-2 2v14h13a2 2 0 0 0 2-2v-7" /><path d="m10 13 1-4 7-7 3 3-7 7-4 1Z" /><path d="M2 8h4M2 12h4M2 16h4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  users: <><circle cx="10" cy="8" r="3" /><path d="M3 21v-2a7 7 0 0 1 14 0v2M17 4a3 3 0 0 1 0 6M21 21v-2a7 7 0 0 0-3-6" /></>,
  sprout: <><path d="M12 21v-9M12 15C3 16 3 9 3 9c8-1 9 6 9 6ZM12 11c0-9 9-8 9-8s1 9-9 8Z" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3V7Z" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  checklist: <><rect x="3" y="5" width="4" height="4" rx="1" /><rect x="3" y="15" width="4" height="4" rx="1" /><path d="M11 7h10M11 17h10" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  palette: <><circle cx="8" cy="9" r=".7" /><circle cx="12" cy="6" r=".7" /><circle cx="16" cy="9" r=".7" /><path d="M21 12a9 9 0 1 0-9 9h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a3 3 0 0 0 3-1Z" /></>,
  shield: <><path d="m12 3 9 4v6c0 5-9 9-9 9s-9-4-9-9V7l9-4Z" /><path d="m8 12 3 3 5-6" /></>,
  model: <><rect x="4" y="7" width="16" height="14" rx="4" /><path d="M12 3v4M8 12v2M16 12v2M9 17h6" /></>,
  puzzle: <path d="M3 3h6v3a3 3 0 1 0 6 0V3h6v6h-3a3 3 0 1 0 0 6h3v6h-6v-3a3 3 0 1 0-6 0v3H3v-6h3a3 3 0 1 0 0-6H3V3Z" />,
  memory: <><path d="M12 5a4 4 0 0 0-7-1 4 4 0 0 0-3 6 5 5 0 0 0 2 8 4 4 0 0 0 8 1V5ZM12 5a4 4 0 0 1 7-1 4 4 0 0 1 3 6 5 5 0 0 1-2 8 4 4 0 0 1-8 1" /><path d="M7 8v4M17 8v4M6 16h3M15 16h3" /></>,
  plug: <><path d="M8 3v5M16 3v5M5 8h14v4a7 7 0 0 1-14 0V8ZM12 19v3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
  inbox: <><path d="m3 13 3-9h12l3 9v7H3v-7ZM3 13h5l1 3h6l1-3h5" /></>,
  file: <><path d="M5 3h9l5 5v13H5V3ZM14 3v6h5M8 13h8M8 17h6" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;

export default function AppIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphs[name]}</svg>;
}
