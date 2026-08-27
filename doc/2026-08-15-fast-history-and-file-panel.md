# 历史会话快速加载 + 文件面板增强

日期：2026-08-15
状态：已实现

## 需求

1. 点击左侧会话历史加载很慢 → 引入分段/快速读取机制加速
2. 右侧文件面板：支持输入任意路径浏览（不局限于会话 cwd）
3. 文件树右键菜单：打开文件 / 打开所在路径 / 添加到对话区 / 复制路径

## 1. 历史会话加载加速

### 瓶颈分析（原串行链路）

点击会话 → spawn 引擎进程（数百 ms 到秒级）→ waitForEngine 就绪探测 → switch_session（引擎全量解析会话 JSONL）→ fetchSessionMeta → 最后才 readSessionPage 渲染。全程秒级阻塞，且 Rust 分页每次全量解析整个文件（大会话含 base64 图片时单条消息可达数 MB）。

### 方案：两阶段加载

- **阶段 A（立即，纯文件读取，~几十 ms）**：`read_session_page` 直接读会话文件渲染最新 30 条，不等引擎。此时会话为只读浏览状态（`connecting`）。
- **阶段 B（后台）**：spawn → 就绪探测 → switch_session → 元数据。完成后会话可续聊。用户在阶段 B 期间发消息：`sendPrompt` 先 await 进行中的 resumePromise，表现为短暂等待后正常发出，不报错、不丢消息。

关键改动：`attachSession` 增加 `keepTimeline` 选项——阶段 B 挂接引擎时不再清空阶段 A 已渲染的时间线；增加 `resumeSeq` 代际守卫，快速连点不同会话时旧的后台连接直接放弃并关闭多余引擎进程。

### Rust 分页加速

用 `serde_json::value::RawValue`（borrowing）解析每行：非窗口行只取 `type`/`id`/`parentId`，不为 `message` 负载建 DOM；只有最终窗口内（≤30 条）的消息做完整解析。大文件下解析开销与内存占用都随窗口大小而非文件大小。行级容错（坏行跳过）保持不变。

备选未采用：从文件尾部反向分块读取。分支链（parentId）可能指向文件任意位置（compaction/fork 后），反向读取仍需回溯校验，复杂度高于收益；RawValue 已把成本降到可忽略。

## 2. 文件面板路径输入

- 头部下方加路径栏：可编辑文本框（当前根路径）+ "上一级"按钮
- 输入合法目录回车即切换根；非法路径 toast 报错；未自定义前根跟随会话 cwd
- 目录树本身已支持任意路径懒加载（`list_dir`），无需改后端

## 3. 文件树右键菜单

- 自绘右键菜单（`onContextMenu` + fixed 定位，点击别处/Esc 关闭）
- 菜单项：
  - 打开文件（系统默认程序）——仅文件
  - 打开所在路径（文件 → explorer `/select,`；目录 → 直接打开该目录）
  - 添加到对话区（走现有 `read_attachment` + `chatStore.addAttachments`）——仅文件
  - 复制路径
- 新增 Rust 命令 `open_path(path, reveal)`：Windows 用 `cmd /c start` / `explorer /select,`，macOS `open`/`open -R`，Linux `xdg-open`/打开父目录；std::process 实现，无新依赖

## 影响面

- Rust：`session_paging.rs`（RawValue）、`files.rs`（open_path）、`main.rs`（注册）、Cargo.toml（serde_json 加 `raw_value` feature）
- 前端：`chat-store.ts`（两阶段 resume）、`FilePanel.tsx`（路径栏 + 右键菜单）、`pi-bridge.ts`（openPath）
