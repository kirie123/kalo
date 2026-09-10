# 子 Agent 超时改为 idle watchdog + 过程转录落盘

> 状态：设计。涉及 `kalo-harness/packages/coding-agent/src/extensions/subagent/index.ts`。
> 关联既有设计：`doc/kalo-subagent-design.md`（子 agent 机制总设计）。

## 1. 问题

当前子 agent 有一个硬编码的墙钟看门狗：

```ts
const HARD_TIMEOUT_MS = 10 * 60_000;
const timer = setTimeout(() => { timedOut = true; void session.abort(); }, HARD_TIMEOUT_MS);
```

它测的是「这个子 agent 一共跑了多久」，不是「它是不是还活着」。两个后果：

1. **健康的长任务被误杀。** 一次要抓 20 个网页、或在大仓库里 grep + 逐个读文件的调研，正常就要十几分钟。它每分钟都在产出 assistant 文本和工具调用，但第 10 分钟一到照样被 `abort()`。
2. **误杀之后还抛错。** 超时走的是 `throw new Error("子 agent 超时（10 分钟）被中止。部分结果：…")`。虽然部分结果拼在了错误文本里，但对父 agent 这是一条 `isError` 工具结果，模型的典型反应是「失败了，重试一次」——前 10 分钟的 token 全部白烧，重试还会再超时一次。

真正需要防的是**卡死**：子会话不再产生任何事件（provider 挂起、工具卡在不返回的 I/O），把父 run 的一次工具调用永久钉住。墙钟时长不是卡死的判据。

## 2. 方案

### 2.1 用活性代替时长（idle watchdog）

子会话的活性信号本来就有：`runChild` 已经 `session.subscribe(...)` 监听 `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end`。把看门狗从「启动后 N 分钟触发一次」改成「**每收到任何一个子会话事件就重置**的 N 分钟定时器」。

- 常量改名 `HARD_TIMEOUT_MS` → `IDLE_TIMEOUT_MS`，默认 **5 分钟**。
- 触发条件：连续 5 分钟没有任何子会话事件 → 判定卡死 → `session.abort()`，标记 `stalled = true`。
- 健康的长任务不受任何总时长限制：只要它还在流式输出 token 或还在调工具，就一直跑。

5 分钟这个阈值对现有工具面是安全的：assistant 流式输出每个 chunk 触发 `message_update`；`bash` 长命令通过 `onUpdate` 触发 `tool_execution_update`；`web_fetch` 自带 20s 超时（`extensions/webfetch/index.ts` 的 `FETCH_TIMEOUT_MS`），不会静默更久。唯一可能静默超过 5 分钟的是「provider 首 token 迟迟不来」，而那本来就该被判为卡死。

**接受的代价**：跑飞的子 agent（陷入工具调用死循环，一直有事件）不会被 idle watchdog 拦住，只能靠用户中止当前轮（abort signal 已经传播到子会话）。这是「不误杀长任务」的直接对价，不再加绝对上限——绝对上限就是这次要去掉的东西。

### 2.2 超时/中止不再抛错，改为带指针的正常结果

`timedOut`（现改称 stalled）和 `aborted` 都返回 `isError: false` 的正常工具结果，文本包含三段：

1. 一句状态说明（为什么停下、跑了几轮）；
2. 子 agent 停下前的最后一段输出（沿用现有 `MAX_RESULT_CHARS` 截断）；
3. **完整过程转录文件的路径**，并明确提示父 agent 可以自行 `read` / `grep` 它。

这样父 agent 拿到的是「一份不完整但可用的结果 + 可自助补全的线索」，而不是「一次失败」。是否重跑、是否只读转录里的某一段，由父 agent 判断。

### 2.3 过程转录落盘

现状是 `SessionManager.inMemory(cwd)`：子会话历史只在内存里，进程一退就没了，所以没有任何可以交给父 agent 的指针。

**不改成普通持久化会话**：`SessionManager.create()` 默认写进 `~/.kalo/agent/sessions/--<encoded-cwd>--/`，而桌面端 `sessions_store::list_sessions` 会把该目录下所有 `.jsonl` 列进侧边栏。子 agent 的会话混进历史会话列表是明确的回退。

**改为写一份 markdown 转录**：

- 位置：`~/.kalo/agent/subagent-transcripts/<时间戳>-<随机后缀>.md`（`getAgentDir()` 下的独立目录，不在 `sessions/` 扫描范围内）。
- 时间戳按 `session-manager.ts` 的既有做法把 `:` `.` 替换成 `-`——**Windows 文件名不允许冒号**，这是硬约束，不是风格问题。
- 内容：从 `session.agent.state.messages` 序列化，逐条渲染 assistant 文本、工具调用（名字 + 参数摘要）、工具结果（截断）。比 JSONL 更适合被父 agent 直接 `read`。
- 写入时机：放在 `runChild` 的 `finally` 里，**正常结束、卡死中止、用户中止都写**。写失败（磁盘满、权限）只吞掉异常并把路径记为 `undefined`，绝不让转录问题炸掉子 agent 的正常返回。

**结果文本里何时给出路径**：仅在 `truncated` / `stalled` / `aborted` 三种情况下附带。正常且未截断时不附带——那时结果本身就是完整的，多一行路径只是噪音。

### 2.4 details 与桌面端呈现

`SubagentDetails` 的 `timedOut?: boolean` 改为 `stalled?: boolean`，新增 `transcriptPath?: string`。桌面端 `ToolCallGroup.tsx` 现在只读 `details.steps` / `details.turns` / `details.activity`，不读 `timedOut`，因此**本次不需要改桌面端**；转录路径已经出现在工具结果文本里，用户在展开的结果中就能看到。

## 3. 不做的事

按本次范围确认，以下保持原样：

- `MAX_CONCURRENCY = 3`（进程级并发信号量）不动、不做成配置项。
- `MAX_RESULT_CHARS = 16_000`（回传文本截断）不动、不做成配置项。截断场景由 2.2 的转录指针补偿。
- 不引入 `settings.json` 配置项。阈值先以常量固化，等有真实需要再谈配置契约。

## 4. 转录文件的生命周期

不做自动清理：转录是排查长任务的一手材料，静默删除会让「子 agent 说结果在这个文件里，文件却没了」。单个转录量级在几十 KB，位置 `~/.kalo/agent/subagent-transcripts/` 用户可自行清空。若日后确实堆积，再单独设计保留策略（按数量或天数）。

## 5. 测试计划

在 `packages/coding-agent/test/kalo-subagent-tools.test.ts` 同域补纯逻辑测试（不启真实 provider）：

- **idle watchdog 重置语义**：把「事件到达 → 重置定时器」抽成可测的小函数或用假定时器驱动，验证「持续有事件时不触发」「静默超阈值时触发一次」。
- **转录序列化**：给定一组 messages，验证输出包含 assistant 文本、工具名、且超长工具结果被截断。
- **文件名安全**：验证生成的转录文件名不含 `:`（Windows 约束回归）。

跑法遵守 `kalo-harness/AGENTS.md`：单文件跑 vitest，不跑全量套件；改完执行 `npm run check`。

## 6. 验收

- 让子 agent 执行一个 12 分钟以上、持续有工具调用的调研任务：不再被中止，正常回传结果。
- 人为构造静默（子会话卡在不返回的操作）：5 分钟后被中止，父 agent 收到非错误结果，文本含转录路径，`read` 该路径能看到中止前的完整过程。
- 桌面端子 agent 卡片的「第 N 步 / 共 N 步」与活动流显示不变。
