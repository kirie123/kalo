# 新会话在侧边栏的即时显示

日期：2026-08-19
状态：已实现

## 现象

新建会话、输入第一条消息后，左侧列表里长时间没有这条会话，要等 agent 跑完一大段才出现。

## 根因（两条，缺一不可）

**1. 引擎故意不落盘。** `session-manager.ts:1013` 的 `_persist`：

```ts
const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
if (!hasAssistant) { /* 只留在内存 */ return; }
```

pi 要等到**第一条 assistant 消息**才把 `.jsonl` 写出来——这是有意的，否则每次点「新对话」都会在磁盘上留一个空文件。而侧边栏列表来自 `sessions_store.rs::list_sessions`，是扫目录得到的。文件不存在，列表里就没有。

**2. 刷新时机正好错过。** `App.tsx` 原来只在 `sessionId` / `isStreaming` / `runningCount` 变化时刷新列表。这三个边沿全部发生在 `agent_start`，也就是**文件出现之前**；下一次刷新要等 `agent_end`。于是在「文件已落盘」到「整轮跑完」之间没有任何触发。

两条叠加，用户看到的就是「等它跑很久才出现」。第一条决定了下限，第二条把下限拉到了整轮结束。

## 不采用的方案

**改引擎，让它立刻落盘。** 能一步解决，但会让每个开了没说话的新对话都在磁盘留一个空会话文件，历史列表会被垃圾填满。`hasAssistant` 这个判断是对的，不该动。

## 方案：乐观条目

store 把「引擎已开、还没落盘」的会话作为 `pendingSessions` 发布出去，侧边栏与磁盘扫描结果合并，**按路径去重**。点发送的那一刻行就出现，不等模型。

```
sendPrompt 第一条消息
   └─► rt.pending = { title: 首行, at: now }  →  commit()
          └─► ChatState.pendingSessions       →  Sidebar 合并渲染（标为 pending）
   └─► syncSessionFile → get_state 拿到 sessionFile → pending 行的 path 补齐
   └─► 首条 assistant 落盘 → list_sessions 扫到 → notePersistedSessions() 退休该行
```

### 关键点

- **path 两段式**：文件路径未知前用 `pending:<runtime key>`，拿到 `sessionFile` 后换成真路径。去重靠的是后者——真路径一出现，磁盘扫描和乐观条目就能对上。
- **去重方向**：磁盘赢。它带着引擎的真标题和真 mtime，所以「占位 → 真实」的切换在界面上看不出来。
- **标题**：先用 prompt 首行（截断 80 字），引擎发 `session_info_changed` 后换成引擎起的名字。
- **补一个轮询**：`.jsonl` 落盘发生在首条 assistant 消息，这个时刻没有任何现成事件对应。有 pending 行时每 2s 扫一次，扫到就退休；没有 pending 行时不轮询。
- **点击 pending 行**：它的 runtime 就在池子里，`resumeSession` 识别 `pending:` 前缀直接切视图，不去读那个还不存在的文件。
- **`...` 菜单**：pending 行没有可删的文件，隐藏。

### 幽灵行的两个出口

乐观条目的风险是「显示了一个永远不会存在的会话」。两处显式退休：

- `sendPrompt` 抛异常 → prompt 没送到引擎，什么都不会落盘 → `dropPending`
- 引擎退出且 `sessionFile` 为空 → 没人再会写这个文件 → `dropPending`

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `PendingSession` |
| `src/lib/chat-store.ts` | `SessionRuntime.pending`；`commit()` 计算 `pendingSessions`（沿用 `runningByFile` 的身份稳定化）；`sendPrompt` 建行、`notePersistedSessions` / `dropPending` 退休行；`resumeSession` 认 `pending:` 前缀；`session_info_changed` 更新标题 |
| `src/lib/session-rows.ts` | 新增：两个来源的合并 + 按路径去重（纯函数） |
| `src/App.tsx` | 刷新后回调 `notePersistedSessions`；有 pending 行时 2s 轮询；透传 `pendingSessions` |
| `src/components/Sidebar.tsx` | 渲染合并后的行；pending 行禁用 `...` 菜单 |

引擎、gateway、Rust 侧：**不动**。

## 验证

- `session-rows.test.ts` 8 个用例：去重（含 Windows 大小写/分隔符差异）、不同文件不误杀、跨来源排序、pending 自带 cwd。
- `tsc --noEmit` 通过；`npm test` 76 个用例通过。
- 手工待验：发第一条消息后行立即出现 → 首条回复后标题换成真标题且不出现重复行 → 中途点别的会话再点回来正常 → 引擎起不来时行消失。
