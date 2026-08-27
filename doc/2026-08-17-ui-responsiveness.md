# 桌面端交互卡顿治理（模型切换等 1~2s 延迟）

## 背景

用户反馈：切换模型要卡一两秒才生效，界面上不少交互都有类似的滞后感。

排查后确认不是单点问题，而是四层叠加：主线程被后端命令阻塞、前端交互全部走「等 RPC 回来再更新 UI」、
引擎就绪探测的退避策略把首次探测拖满 2s、store 每次 commit 触发整棵树重渲染。

本文记录治理方案与取舍。

## 问题清单与方案

### 1. 所有 Tauri 命令都是同步的 → 阻塞窗口事件循环

`src-tauri/src/main.rs` 中 37 个 `#[tauri::command]` 无一是 async。Tauri v2 里同步命令在主线程执行，
主线程即窗口事件循环，命令执行多久窗口就冻多久。开销大的有：

- `search_files`：最多遍历 50,000 个目录项，输入框 `@` 补全每 150ms 触发一次
- `list_sessions`：扫描全部会话目录，每个文件解析前 100 行 JSON，随会话数线性增长
- `create_session`：同步 spawn 引擎子进程
- `read_session_page` / `list_dir` / `read_file_text` / `read_attachment`：同步磁盘 IO

**方案**：给这些命令加 `#[tauri::command(async)]`。该属性让 Tauri 把同步函数体丢到 async runtime 的线程池执行，
函数体一行不用改，也不需要处理 `State` 的 `Send` 约束（相比改成 `async fn` 风险更低）。

只对「有实际 IO / 进程开销」的命令加，纯内存查询（`gateway_status`、`schedule_list`、`jobs_list`）保持同步，
省一次线程调度。

`send_command` 也**故意保持同步**：它的函数体只是取锁 + 往写线程的 channel 推一行（真正的 stdin 写在
`PiProcess` 的专用写线程里），本身不阻塞；而挪到线程池会丢掉「前端发出顺序 == 引擎收到顺序」这个保证。

### 2. 前端交互全部「等 RPC 回来再更新 UI」

`setModel` 的路径是 `ensureSession()` → `set_model` RPC → 才更新 `currentModel`。
没有会话时 `ensureSession` 要走完 spawn 进程 → 就绪探测 → `fetchSessionMeta`（4 个 RPC）→ `applySavedModel`，
1~2s 完全说得通。而引擎侧 `set_model` 本身只是内存查表，并不慢。

**方案**：
- **乐观更新**：点击后立即写入 `currentModel` 并持久化，失败再回滚 + toast。
- **不为切模型而起引擎**：没有 `sessionId` 时只记本地偏好，反正建会话时 `applySavedModel` 会应用。
- `cycleThinkingLevel` / `setSteeringMode` 同样处理（思考等级本地按已知等级表推进下一档）。

取舍：乐观更新意味着极短暂的「显示已切换但引擎还没切」窗口。可接受——失败会回滚并弹 toast，
且这两个设置都不影响已发出的请求。

### 3. `waitForEngine` 首次探测最坏白等 2s

探测用 `sendCommand(..., 2000)`，而引擎 RPC 循环未就绪时命令被静默丢弃，
于是首发必须等满 2000ms 超时才重试。

**方案**：探测超时从 300ms 起，随退避一起增长（上限 2000ms），总预算不变。
典型情况下引擎 ~600ms 就绪，改后第二次探测即命中，省掉约 1.5s。

### 4. store 每次 commit 触发整棵树重渲染

`App` 直接 `useChatStore()` 拿整个 state，而 `commit()` 每次生成新对象。
流式输出时 20fps 刷新 → App 每秒重渲染 20 次 → Sidebar / ChatView / FilePanel 全部跟着重渲染。
Sidebar 未 memo，且 App 每次传新的箭头函数 prop，加 memo 也无效。

**方案**（按性价比排序，全做）：
- `commit()` 中保持 `runningByFile` 的引用稳定（键集合未变则复用旧对象），
  否则任何按字段订阅都会因为这个每次新建的对象而失效。
- 新增 `useChatSelector(selector, isEqual)`：基于 `useSyncExternalStore` + 缓存快照 + 浅比较，
  组件只订阅自己用到的字段。
- `App` 改用 selector 只订阅 `cwd / sessionId / engineSessionId / isStreaming / runningByFile / hasTimeline`，
  回调用 `useCallback` 包稳，`Sidebar` 用 `memo` 包住。
- `AssistantMessage` 的 markdown 块拆成 memo 子组件（按文本比较），
  流式期间只有最后一个正在增长的块重新解析；`highlight.js` 结果按 `(lang, code)` 做 LRU 缓存，
  避免 `highlightAuto` 每帧重跑（它是全场最贵的一步）。
- `App` 的 `refreshProjects` 依赖 `isStreaming`，每次运行开始/结束都全量重扫会话目录；
  改为 300ms 防抖，避免连续状态跳变触发多次扫描。

## 不做的事

- 不改 store 的整体架构（引擎池、SessionRuntime 的划分保持原样），只在订阅层做收窄。
- 不引入 zustand / redux 等状态库，`useSyncExternalStore` 已经够用。
- 不给 Rust 侧的文件扫描加缓存/监听（会话列表增量更新）——当前会话数量下收益不明显，
  等 `list_sessions` 挪出主线程后再看是否需要。
- `useChatStore()`（全量订阅）保留为公开 API，但组件侧已全部改用 `useChatSelector`。

## 验证

`cargo check`、`tsc --noEmit`、`vite build` 均通过。未启动桌面端做人工回归。
