/** 首屏快捷场景。
 *
 * 这里是**数据**，不是逻辑：QuickActions 组件只负责把这张表渲染成一排入口卡，
 * 点一下把 prompt 填进输入框（不直接发送——大多数场景要先填个股票代码或
 * 目录名）。加一个场景就在这里加一行，不用碰组件。
 *
 * `icon` 是字符串 key 而不是 JSX——SVG 留在 EmptyState 的 ICONS 映射表里，
 * 这张表才能保持纯数据。`tone` 选图标配色（见 index.css 的 --tone-*）。
 *
 * 领域知识只应该出现在这类数据表和 skill 的 markdown 里，不该长进组件代码。
 */
export interface QuickAction {
  /** 入口卡上的字，尽量 4 个汉字以内 */
  label: string;
  /** 填进输入框的话。留有需要用户补全的位置时，把它放在末尾 */
  prompt: string;
  /** 图标 key，必须是 EmptyState 里 ICONS 表的一个键 */
  icon: QuickActionIcon;
  /** 图标配色 */
  tone: QuickActionTone;
}

export type QuickActionIcon = "trend" | "report" | "paper" | "search" | "book" | "flask";

export type QuickActionTone = "blue" | "green" | "orange" | "violet" | "pink";

export const QUICK_ACTIONS: QuickAction[] = [
  { label: "市场风向", prompt: "现在的宏观市场环境怎么样？", icon: "trend", tone: "green" },
  { label: "看财报", prompt: "帮我分析这家公司最近几期的财报：600519", icon: "report", tone: "orange" },
  { label: "精读论文", prompt: "帮我精读这篇论文：", icon: "paper", tone: "violet" },
  { label: "在线调研", prompt: "帮我调研一下这个题目，给一份结构化综述：", icon: "search", tone: "blue" },
  { label: "记到知识库", prompt: "帮我把下面这段记进知识库：", icon: "book", tone: "pink" },
  { label: "跑实验队列", prompt: "看一下 experiments/queue.md，按队列继续跑实验。", icon: "flask", tone: "blue" },
];
