# 输入区斜杠命令与 @ 文件补全 + 文件面板后退导航

日期：2026-08-15
状态：已实现

## 需求

1. 文件面板路径栏：在"上一级"左侧加"后退"按钮，回到上次浏览的目录
2. 输入框：输入 `/` 弹出可用斜杠命令（含技能），输入 `@` 弹出文件补全

## 1. 文件面板后退导航

- FilePanel 维护一个后退栈：任何导航（路径栏回车、上一级、树内点目录不算——树内展开不改变根）都把当前根压栈
- 后退按钮出栈并跳转，不再压栈；栈空时按钮置灰
- 仅前端状态，不持久化

## 2. 输入框自动补全

### 数据来源

- **斜杠命令**：引擎 `get_commands` RPC 返回扩展命令（remember 等）、技能（`skill:<name>`）、prompt 模板。`fetchSessionMeta` 时一并拉取存入 `ChatState.commands`；本地按前缀过滤，无需重复请求
- **@ 文件**：新增 Rust 命令 `search_files(root, query)`——从会话 cwd 递归遍历，大小写不敏感子串匹配文件名，跳过 dotfile 与 node_modules/target/dist/__pycache__，遍历上限 5 万条目、结果上限 20，前缀匹配优先排序

### 交互（InputBox 内）

- 检测光标前 token：`/xxx`（行首或空白后）→ 命令模式；`@xxx` → 文件模式
- 弹窗在输入框上方，↑↓ 选择、Enter/Tab 确认、Esc 关闭；弹窗打开时 Enter 不触发发送
- 选中命令：插入 `/<命令名> `（如 `/skill:paper-reading `），发送时由引擎展开执行
- 选中文件：插入相对/绝对路径文本（agent 可用工具读取），弹窗有 150ms 防抖

## 影响面

- Rust：`files.rs`（search_files）、`main.rs`（注册）
- 前端：`InputBox.tsx`（补全弹窗）、`chat-store.ts`（commands 拉取与状态）、`types.ts`（SlashCommand）、`pi-bridge.ts`（searchFiles）、`FilePanel.tsx`（后退栈）
