# Kalo 子 Agent 机制设计（harness 层）

> 状态：已实现。对应 roadmap P1-C。
>
> 后续演进：子 agent 已从「单发、跑完即弃」改为「常驻、可续写」，历史落盘到父会话所在的 cwd 桶下。
> 本文 §3.1 / §3.2 中涉及工具契约、内存历史与释放时机的段落已被修订，以
> [可续写子 Agent、外部托管 Job 与主 Agent 派生](2026-09-11-可续写子agent与主agent派生.md) 为准。

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
agent(prompt: string, description?: string, tools?: string[], resume?: string)
```

- `prompt`：完整、自包含的任务描述（子 agent 看不到主对话）。搭配 `resume` 时写要追加的新指令。
- `description`：3-5 词任务摘要，用于进度呈现。
- `tools`：子 agent 可用工具，默认 `["read","grep","glob","ls","web_fetch"]`（只读探索 + 联网）。允许 `bash` 等但由用户在系统配置中放开（P2 权限模型）。`resume` 时忽略，沿用创建时的工具集。
- `resume`：要继续的子 agent id（如 `subagent-2`）。缺省则新建。每次返回结果都附带 id 与用法提示，中断（报错 / 卡死 / 用户中止）时尤其如此 —— 那正是最需要续写而非重派的时刻。

工具描述明确指引：独立、可并行、无需主对话上下文的任务才委派；一次消息可发多个 `agent` 调用并行执行。

### 3.2 生命周期（extensions/subagent/index.ts）

1. **派生**：`createAgentSession({ cwd: 主会话 cwd, tools: 参数裁剪, sessionManager: 文件型, resourceLoader: noExtensions })`——同进程、独立消息历史、独立 system prompt；`noExtensions` loader 同时杜绝递归派生（子会话没有 `agent` 工具）与 MCP/memory 干扰。
2. **历史隔离与落盘**：`SessionManager.create(cwd, <桶>/subagent/<主会话id>/, { id, parentSession })`——子会话写入父会话所在 cwd 桶下的 `subagent/<主会话id>/` 目录。注意文件名由 `SessionManager` 自己决定（`<时间戳>_<childId>.jsonl`），调用方只能指定目录，因此查找子会话要用 `findChildSessionFile()` 按 `_<childId>.jsonl` 后缀识别。因为引擎与桌面端的会话扫描均为非递归、且只认桶内 `.jsonl` 文件，子目录天然不进会话列表（无需过滤代码；有回归测试守住）。
3. **执行**：新建走 `session.prompt(prompt)`；`resume` 一个正在跑的子 agent 走 `session.followUp(prompt)` 排队，已停下的走 `prompt` 开新一轮。两者按 `isStreaming` 分派，不由模型选择。注意 `followUp()` **只入队即返回**，不等回答，所以这条路径必须再 `waitForIdle()` 等 `agent_end`（且 `willRetry !== true`），否则会在子 agent 话说到一半时返回空回复。
4. **回传**：取**本轮**最后一条 assistant 文本（按 baseline 切片，避免续写时返回上一轮的旧答案），按 16K 字符截断，附 tokens 用量与子 agent id。
4b. **报错不丢弃**：provider 报错**不会抛异常**，而是以 `stopReason: "error"` + `errorMessage` 的 assistant 消息落地，`prompt()` 照常 resolve。因此要同时检查抛出值和这类消息，把原因放进 `ChildOutcome.failed` 并单独成一个返回分支。只看异常的话，主 agent 只会看到「未产生回复」，没法判断该原样 resume 还是改 prompt。
5. **取消**：主 run 的 abort signal 传播到子 session（`sub.abort()`）。
6. **活性看门狗**：连续 5 分钟无任何子会话事件才判为卡死并中止；不设总时长上限。中止不抛错，返回部分结果 + 转录路径。详见 [子 Agent 超时改为 idle watchdog + 过程转录落盘](2026-09-10-子agent-idle-watchdog与转录落盘.md)。
7. **并发上限**：进程级信号量，默认 6；超限的调用排队等待。可用环境变量 `KALO_SUBAGENT_CONCURRENCY`（整数 ≥ 1）覆盖，非法值回落到默认。云端模型能真并行，本地模型推理本身串行排队，语义一致（只是队列更深）。
   **`resume` 一个已常驻的子 agent 不申请新槽位**：否则 6 个槽位被跑着的子 agent 占满时，想 resume 其中一个来救它会死锁在信号量上——排队等的正是它自己。续写也不新增 provider 连接，不破坏上限的初衷。
8. **常驻上限**：`Map<childId, ChildHandle>` 默认最多 16 条（`KALO_SUBAGENT_RESIDENT` 可调），超限按 `lastActiveAt` LRU 驱逐 —— 只驱逐非 running 的，否则会截断飞行中的一轮。因为历史已落盘，**驱逐不丢失能力**：被驱逐的子 agent 仍可 `resume`，只是要从文件重建（`SessionManager.open`）。同理，上一个引擎进程留下的子 agent 也能接上；但引擎重启不自动复活任何子 agent。
9. **唤醒围栏**：`resume` 只认本会话自己的子 agent。别人的子 agent 与不存在返回同一句「未知子 agent」——id 可猜，区分两者会泄露别的会话持有哪些子 agent。路径里的主会话 id 是第二道冗余围栏。
8. **嵌套**：子会话不注册 `subagent` 扩展（通过 `excludeTools: ["agent"]` + 子会话不加载该扩展的守卫），防止递归派生。

### 3.3 桌面端呈现

复用现有 toolGroup 渲染：`agent` 工具调用显示为普通工具卡片（args 里带 description）。子会话过程明细（嵌套时间线）留 P2。

### 3.4 过程转录

转录（markdown）与会话文件同目录：`<桶>/subagent/<主会话id>/<childId>.md`，**按轮追加**而非覆盖——可续写的子 agent 有多轮历史，覆盖会只剩最后一轮可读。文档标题只在第 1 轮写入，之后每轮追加一个 `## 第 N 轮` 节（含本轮 prompt 与结束原因）。它面向主 agent 用 `read`/`grep` 消费，与 `.jsonl` 的机器可读用途不重叠，放一起便于排查时对照。

### 3.4 过程转录

子会话历史只在内存，中途停下或结果被截断时父 agent 无从追查，因此每次子 agent 结束都把过程序列化为 markdown 写到 `~/.kalo/agent/subagent-transcripts/`（不在 `sessions/` 下，避免混进桌面端会话列表）。实现见 `extensions/subagent/transcript.ts`。

## 4. 测试计划

- 单测/冒烟：mock stream 下派生 → prompt → 回传文本 → 截断与 isError 路径；abort 传播；并发信号量。
- 手测：Ollama qwen 下让主 agent "分别调研 A、B 两个目录再汇总"，观察两个 `agent` toolCall 并行执行。

## 5. 关联：桌面端引擎池（同批实现，前端侧）

多会话并行与子 agent 无直接耦合，一并交付：

- Rust 端 `SessionManager.sessions: HashMap<String, PiProcess>` 已支持多进程并存，无需改动。
- 前端 `chat-store` 从单会话假设重构为 **runtime 池**：`Map<key, SessionRuntime>`（key = 会话文件路径或临时引擎 id），active 指针决定渲染谁；后台 runtime 的事件继续路由更新其 timeline（`pi-event:{id}` Tauri 事件天然按引擎进程分发）。
- 切换会话 = 换 active 指针（不杀进程、不停监听）；LRU 上限 4 个空闲后台引擎自动回收。
- Sidebar 会话项按 `runningByFile` 渲染转圈指示（CSS spinner）。
