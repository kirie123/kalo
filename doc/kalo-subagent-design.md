# Kalo 子 Agent 机制设计（harness 层）

> 状态：已实现。对应 roadmap P1-C。

## 1. 需求与约束

- 主 agent 需要把独立子任务（代码调研、多文件探索、批量验证）委派出去，避免撑爆主上下文。
- Kalo 的主力模型是本地 Ollama（qwen 4b~35b）：**工具面必须极简**，复杂多工具编排（9 个原语）或要求模型写 JS 编排脚本的方案对中小模型不可靠。
- harness 已具备全部基础设施：`createAgentSession`（sdk.ts）可在同进程派生带裁剪工具集的独立 `AgentSession`；extensions 的 `registerTool` 可注入模型可见工具。

## 2. 方案对比

| | workflow 编排方案 | 多原语协作方案 | **Kalo 选择：单发 Task 工具** |
|---|---|---|---|
| 模型接口 | 1 个工具（JS 编排脚本 + `agent()`/`pipeline`/`parallel`） | 9 个原语工具（spawn/send/wait/list/close…） | 1 个工具（`agent`），一次调用一个子任务 |
| 子 agent 形态 | worker-thread 沙箱内跑脚本，agent 为同进程子会话 | 独立线程 + AgentContext 隔离 | 同进程 `AgentSession`（继承 createAgentSession） |
| 并发 | 脚本级 caps（并发/总量上限） | 线程调度 | 模型在一条消息里发多个 `agent` toolCall = 天然并行 + 信号量上限 |
| 适合 | 强云端模型、大规模扇出 | 长期协作型多 agent、agent 间通信 | 中小本地模型、独立子任务委派 |

**选型理由**：表达力上多原语协作 > workflow 编排 > 单发 Task，但认知负担同序反向。对本地中小模型，单工具、一次调用、结果即回传的形态成功率最高；并行需求由"多个 toolCall 同轮并行执行"天然满足（pi-agent-core 已并行执行同轮 toolCall）。未来若需要 workflow，可以把本工具作为脚本引擎的 `agent()` 原语向上叠加，不冲突。

## 3. 详细设计

### 3.1 工具契约（模型可见）

```
agent(prompt: string, description?: string, tools?: string[])
```

- `prompt`：完整、自包含的任务描述（子 agent 看不到主对话）。
- `description`：3-5 词任务摘要，用于进度呈现。
- `tools`：子 agent 可用工具，默认 `["read","grep","glob","ls"]`（只读探索）。允许 `bash` 等但由用户在系统配置中放开（P2 权限模型）。

工具描述明确指引：独立、可并行、无需主对话上下文的任务才委派；一次消息可发多个 `agent` 调用并行执行。

### 3.2 生命周期（extensions/subagent/index.ts）

1. **派生**：`createAgentSession({ cwd: 主会话 cwd, tools: 参数裁剪, sessionManager: in-memory, resourceLoader: noExtensions })`——同进程、独立消息历史、独立 system prompt；`noExtensions` loader 同时杜绝递归派生（子会话没有 `agent` 工具）与 MCP/memory 干扰。
2. **历史隔离**：`SessionManager.inMemory()`——子会话消息只留在内存，不落盘、不污染主 sessions 目录（桌面端会话列表不受影响）；进程退出即释放。
3. **执行**：`await sub.prompt(prompt)` 跑完整 agent loop（含其自己的工具调用与重试）。
4. **回传**：取子会话最后一条 assistant 文本，按 16K 字符截断（`...[truncated N chars]`），附 tokens 用量；子 agent 失败/超时 → `isError` 结果，错误隔离不炸主 run。
5. **取消**：主 run 的 abort signal 传播到子 session（`sub.abort()`）。
6. **并发上限**：进程级信号量 3；超限的调用排队等待（本地 Ollama 推理本身串行排队，语义一致）。
7. **嵌套**：子会话不注册 `subagent` 扩展（通过 `excludeTools: ["agent"]` + 子会话不加载该扩展的守卫），防止递归派生。

### 3.3 桌面端呈现

复用现有 toolGroup 渲染：`agent` 工具调用显示为普通工具卡片（args 里带 description）。子会话过程明细（嵌套时间线）留 P2。

## 4. 测试计划

- 单测/冒烟：mock stream 下派生 → prompt → 回传文本 → 截断与 isError 路径；abort 传播；并发信号量。
- 手测：Ollama qwen 下让主 agent "分别调研 A、B 两个目录再汇总"，观察两个 `agent` toolCall 并行执行。

## 5. 关联：桌面端引擎池（同批实现，前端侧）

多会话并行与子 agent 无直接耦合，一并交付：

- Rust 端 `SessionManager.sessions: HashMap<String, PiProcess>` 已支持多进程并存，无需改动。
- 前端 `chat-store` 从单会话假设重构为 **runtime 池**：`Map<key, SessionRuntime>`（key = 会话文件路径或临时引擎 id），active 指针决定渲染谁；后台 runtime 的事件继续路由更新其 timeline（`pi-event:{id}` Tauri 事件天然按引擎进程分发）。
- 切换会话 = 换 active 指针（不杀进程、不停监听）；LRU 上限 4 个空闲后台引擎自动回收。
- Sidebar 会话项按 `runningByFile` 渲染转圈指示（CSS spinner）。
