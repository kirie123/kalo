/**
 * Icons for the onboarding bullet cards.
 *
 * Same shape language as the sidebar's set (16×16 viewBox, 1.3–1.5 stroke,
 * `currentColor`): the tour should look like the app it introduces. They live
 * here rather than in `steps.ts` so that file stays pure data — adding a step
 * means adding a row and, at most, one entry to the map below.
 */

import type { ReactNode } from "react";

export type IconKey =
  | "folder"
  | "diff"
  | "archive"
  | "database"
  | "gauge"
  | "calendar"
  | "note"
  | "review"
  | "memory"
  | "ticker"
  | "clock"
  | "evolve";

const S = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const ICONS: Record<IconKey, ReactNode> = {
  // 工作目录
  folder: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.3 1.6h5.5A1.5 1.5 0 0114 6.1v5.4A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-7z" />
    </svg>
  ),
  // 逐行 diff
  diff: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <path d="M3.5 4.5h4M5.5 2.5v4M8.5 11.5h4" />
      <path d="M11 2.5v3.2a2 2 0 01-2 2H6.2M5 13.5v-3.2a2 2 0 012-2h2.8" opacity="0.55" />
    </svg>
  ),
  // 会话落盘
  archive: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <rect x="2.5" y="3" width="11" height="3" rx="0.8" />
      <path d="M3.5 6v6a1 1 0 001 1h7a1 1 0 001-1V6M6.5 9h3" />
    </svg>
  ),
  // 取数层
  database: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <ellipse cx="8" cy="4" rx="4.5" ry="1.8" />
      <path d="M3.5 4v8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4M3.5 8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" />
    </svg>
  ),
  // 分位数 / 判断层
  gauge: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <path d="M2.5 11a5.5 5.5 0 1111 0" />
      <path d="M8 11l2.8-3.2" />
      <circle cx="8" cy="11" r="0.9" />
    </svg>
  ),
  // 每天攒历史
  calendar: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.2" />
      <path d="M2.5 6.5h11M5.5 2.5v2M10.5 2.5v2M5.5 9h1.5M9 11.5h1.5" />
    </svg>
  ),
  // markdown 笔记
  note: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <path d="M4 2.5h5.2L12 5.3v8.2a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1z" />
      <path d="M9 2.5v3h3M5.5 8.5h4M5.5 11h2.5" />
    </svg>
  ),
  // 待审阅
  review: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <path d="M3 3.5h10v9H3z" />
      <path d="M5.5 7.5l1.6 1.6L10.5 5.7" />
    </svg>
  ),
  // 长期记忆
  memory: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11" />
    </svg>
  ),
  // 顶栏跑马灯
  ticker: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <path d="M2 5.5h12M2 10.5h12" opacity="0.4" />
      <path d="M4 8h3.2l1.4-2.2L10 10l1.2-2h1.3" />
    </svg>
  ),
  // 定时任务
  clock: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  ),
  // 程序搜索
  evolve: (
    <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth="1.3" {...S}>
      <circle cx="8" cy="3.2" r="1.4" />
      <circle cx="4.2" cy="12" r="1.4" />
      <circle cx="11.8" cy="12" r="1.4" />
      <path d="M8 4.6v2.6M8 7.2L4.8 10.7M8 7.2l3.2 3.5" />
    </svg>
  ),
};
