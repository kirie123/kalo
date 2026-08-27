# 一轮结束后的「改动文件」汇总卡片

日期：2026-08-18
状态：已实现

## 需求

一轮 agent 执行结束后，如果这一轮编辑或生成了文件，在时间线末尾给出一张汇总卡片：

```
编辑了 3 个文件                                   +213 -14
  paper-drama/src/paperdrama/tools/artifact_tools.py   +134 -13
  paper-drama/src/paperdrama/agents/writer.py           +71  -1
  paper-drama/tests/test_artifacts.py                    +8   0
```

目的：一轮里工具调用被折叠成若干组，滚上去才能看清到底动了哪些文件。卡片把"这一轮的净结果"单独讲一遍。

## 设计原则

这是通用能力，不掺任何领域逻辑：只认 `write` / `edit` 两个工具的调用结果，不认路径含义、不认文件类型、不做特殊分类。

## 数据来源

桌面端已有的事件足够，不需要新协议：

| 来源 | 用途 |
| --- | --- |
| `tool_execution_end`（`toolName === "edit"`） | `result.details.diff` → 复用 `DiffView.diffStats()` 得 `+/-` |
| `tool_execution_end`（`toolName === "write"`） | 目前 `details: undefined`，只能从 `args.content` 数行 |
| `agent_start` / `agent_settled` | 一轮的边界（与 turn-usage 页脚同口径） |

### write 的行数问题

`write` 覆盖已有文件时，前端拿不到旧内容，算不出删除行数，也分不清"新建"还是"覆盖"。两条路：

- **A（纯前端）**：`write` 一律记为 `+content行数`，删除数留空。覆盖大文件时数字会明显偏乐观。
- **B（推荐，改 harness 一处）**：`kalo-harness/.../core/tools/write.ts` 的返回值补上
  `details: { created: boolean, added: number, removed: number }`（写入前若文件存在则读一次旧内容算差值）。
  这是通用信息、不含任何 kalo 特有语义，改动约 10 行，也为将来的 Undo 留了口子。

采用 B，同时前端保留 A 作为兜底：`details` 缺失（旧引擎、历史会话）时按 A 计数并且只显示 `+`。

## 数据结构

`chat-store.ts` 新增一种时间线条目：

```ts
export interface ChangedFile {
  /** 相对 cwd 的展示路径，无法相对化时用绝对路径。 */
  path: string;
  added: number;
  /** undefined = 未知（旧引擎的 write），UI 上不显示 -N。 */
  removed?: number;
  /** 本轮里这个文件被改了几次，用于 title 提示。 */
  edits: number;
  /** 本轮首次出现时是 write 且 created=true。 */
  created: boolean;
  /** 最后一次 edit 的 details.diff，供行内展开查看。 */
  lastDiff?: string;
}

export interface ChangesEntry {
  id: string;
  kind: "changes";
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}
```

聚合逻辑放在独立纯函数模块 `src/lib/changed-files.ts`（`accumulate(map, rec, cwd)` / `finalize(map)`），
不依赖 store，方便以后单测（目前 kalo-desktop 没有测试运行器，先不引入）。

## 行为

- **按轮聚合**：`agent_start` 清空累加器；每个成功的 `write` / `edit`（`status === "success"`）并入累加器，按路径去重、`+/-` 相加、`edits++`；`agent_settled` 时若累加器非空，往时间线尾部推一条 `ChangesEntry` 并清空。
- **失败的调用不计入**（编辑失败没改到文件）。
- **中途 abort**：`agent_settled` 照常触发，卡片显示已经落盘的那部分——这正是用户最需要看到的。
- **子 agent 内部的编辑不计入**：它们不在父会话发 `tool_execution_end`。卡片标题因此是"本轮直接编辑"的口径，暂不追子 agent（需要时再从 `agent` 工具的 activity 里补，属于后续项）。
- **历史会话不回溯**：`buildTimeline()` 重建历史时不造 `ChangesEntry`（轮边界在历史消息里不可靠）。与 turn-usage 页脚一致。
- **没有文件改动就没有卡片**，不出现"编辑了 0 个文件"。

## UI

新组件 `src/components/ChangedFilesCard.tsx`，`MessageList` 的 `switch` 里加 `case "changes"`。

- 卡片风格沿用现有 `ToolCallGroup`：`border-edge` / `bg-card` 圆角，标题行左边图标、中间"编辑了 N 个文件"、右边 `+213 -14`（`--diff-add-text` / `--diff-del-text` 上色）。
- 默认展开（一轮结束时用户就是想看这个）；点标题折叠。
- 每行：路径（长路径中间省略、`title` 显示全路径与 `edits` 次数）+ 右侧 `+a -d`。
- 行点击 = 打开 **文件查看弹窗**（`FileViewerModal`，portal 到 `<body>`，避开聊天区缩放）：
  - 头部：路径（`title` 给绝对路径）、`改动 / 全文` 切换（只有 edit 行才有 diff，write 行直接进全文）、复制路径、**全屏**、关闭。
  - 全屏 = 弹窗撑满视口（`inset-0`）；Esc 先退全屏，再按一次才关闭；点遮罩关闭。
  - 全文通过已有的 `read_file_text` 懒加载，只在切到该标签时读一次；二进制 / 截断 / 读取失败都有明确文案。
  - `ChangedFile` 因此多存一个 `fullPath`（工具参数是相对路径时按 cwd 拼绝对路径）。
- **Undo 不做**（v1）。理由要说清楚：撤销需要改动前的完整快照，`edit` 的 `details.patch` 只在文件此后未被再次修改时才可逆，反向应用一个已经过时的 patch 会静默毁坏文件。要做就得在引擎侧写入前落快照（`~/.kalo/agent/undo/<session>/`），那是独立一件事，等这张卡片先跑起来再说。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `kalo-harness/packages/coding-agent/src/core/tools/write.ts` | 返回 `details: { created, added, removed }` |
| `kalo-desktop/src/lib/changed-files.ts` | 新增：聚合纯函数 |
| `kalo-desktop/src/lib/chat-store.ts` | `ChangedFile` / `ChangesEntry` 类型、`rt.runChanges`、`agent_start` / `tool_execution_end` / `agent_settled` 三处挂钩 |
| `kalo-desktop/src/components/ChangedFilesCard.tsx` | 新增：卡片组件 |
| `kalo-desktop/src/components/FileViewerModal.tsx` | 新增：行点击后的查看弹窗（改动 / 全文 / 全屏） |
| `kalo-desktop/src/components/MessageList.tsx` | 渲染分支 |

## 验证

- `tsc` 通过（harness `tsconfig.build.json` 与 kalo-desktop 均干净）。
- 新增 `test/write-tool-details.test.ts`（vitest，5 例）：新建 / 覆盖 / 无尾换行 / 读旧内容失败仍照常写入 / 无 `readFile` 的远端 backend 报未知。
- `node scripts/ensure-engine.mjs` 重编 pi.exe，新 `details` 已进引擎。
- 待手工确认：跑一轮改 2 个文件 + 新建 1 个，核对行数与 `git diff --stat` 一致；abort 一轮只列已落盘文件；一轮不改文件时没有空卡片。

## 附：粘贴 / 拖拽附件

用户同一批提的另一项需求（粘贴或拖入文件变成输入框上方的附件 chip）**已经实现**，方案见
`doc/2026-08-17-input-paste-and-drop-files.md`，代码在 `InputBox.tsx` / `chat-store.ts` / `files.rs`（尚未提交）。
