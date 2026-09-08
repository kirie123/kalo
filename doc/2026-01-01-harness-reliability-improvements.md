# Agent 引擎可靠性改进

**日期**: 2026-01-01  
**影响范围**: `kalo-harness/packages/{agent, ai, coding-agent}`  
**动机**: 修复当前 harness 在长任务可靠性、工具参数兼容性、压缩熔断逻辑上的已知短板。

---

## 背景

生产环境中暴露的一系列隐蔽且致命的问题：

- **流式协议解析**：网关乱序/批量事件导致工具参数丢失，UI 永久卡死
- **上下文压缩**：熔断死锁（连续失败计数不重置、判据用绝对值 → 永久关停压缩 → 长任务必死）
- **空响应误判**：模型只输出 thinking 但无文本/工具调用时被误判为"任务完成"
- **流式挂死**：网关故障时无超时机制，连接永久阻塞

本文档实现 5 个关键改进点。

---

## 1. grep 工具：接受 `query` 作为 `pattern` 的别名

### 问题

`kalo-harness/packages/agent/src/harness/tools/grep.ts` 的 schema 只定义了 `pattern` 参数，但弱模型（deepseek-v4-flash、glm 等）倾向于输出 `query`。这导致 schema 校验失败，工具无法执行，模型收到错误后只输出 thinking（"我要重试"）但没有实际动作，agent-loop 误判为任务完成退出。

### 解决方案

在 `createGrepTool()` 中添加 `prepareArguments` 钩子：

```typescript
prepareArguments: (args: any) => {
  // Accept "query" as alias for "pattern" (common in weaker models)
  if (args.query !== undefined && args.pattern === undefined) {
    return { ...args, pattern: args.query };
  }
  return args;
},
```

**影响**：grep 工具对弱模型更鲁棒，避免一整类"工具参数校验失败 → 空响应 → 任务被误判完成"的沉默故障。

---

## 2. agent-loop：修复"只有 thinking、无可见输出"被误判为完成

### 问题

当前 `packages/agent/src/agent-loop.ts` 在 `hasMoreToolCalls = false` 且 `pendingMessages` 为空时直接 break 退出循环，不区分：
- 模型给了用户可见的答复（text 块）
- 模型只输出了 thinking 但什么都没做（无 text、无 tool call）

后者常出现在工具参数校验失败后：模型说"我要重试"，但引擎静默判为任务完成。

### 解决方案

在工具调用检查后增加逻辑：

```typescript
} else {
  // No tool calls and clean stop: check if message has any visible content
  const hasText = message.content.some((c) => c.type === "text" && c.text.trim().length > 0);
  const hasThinking = message.content.some((c) => c.type === "thinking");

  // If only thinking without any text/tool output, inject continuation to prevent silent task abandonment
  if (!hasText && hasThinking) {
    const continuationMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "You provided reasoning but no visible output or action. Please proceed with the task." }],
      timestamp: Date.now(),
    };
    currentContext.messages.push(continuationMessage);
    newMessages.push(continuationMessage);
    hasMoreToolCalls = true; // Force continuation
  }
}
```

**影响**：防止工具失败后的轮次被静默吞掉，提高长任务的完成率。

---

## 3. agent-loop：max_tokens 截断后自动续写

### 问题

当前代码对 `stopReason === "length"` 的处理仅在有工具调用时把它们标记为错误（`failToolCallsFromTruncatedMessage`），但如果截断的是纯文本输出（无 tool call），不会自动续写。

### 解决方案

在工具调用检查前增加分支：

```typescript
if (toolCalls.length > 0) {
  // ... existing logic
} else if (message.stopReason === "length") {
  // Output was truncated but no tool calls: inject continuation message
  const continuationMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "Output token limit reached. Continue directly from where you left off—no apology, no recap, just resume." }],
    timestamp: Date.now(),
  };
  currentContext.messages.push(continuationMessage);
  newMessages.push(continuationMessage);
  hasMoreToolCalls = true; // Force continuation
}
```

**影响**：长输出任务不会在 max_tokens 处硬截断，自动续写直到完成或达到重试上限。

---

## 4. 流式解析：空闲看门狗（60s 无事件则 abort）

### 问题

当前 `packages/ai/src/api/anthropic-messages.ts` 的流式处理没有空闲超时。网关半死不活时（连接保持但不发数据），代码会永远阻塞在 `reader.read()` 上。

### 解决方案

1. 添加超时配置函数（支持 `PI_STREAM_IDLE_TIMEOUT_MS` 环境变量，默认 60s）：

```typescript
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

function getStreamIdleTimeout(env?: ProviderEnv): number {
  const envValue = getProviderEnvValue("PI_STREAM_IDLE_TIMEOUT_MS", env);
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}
```

2. 在 `iterateSseMessages` 的 `reader.read()` 调用处包装超时：

```typescript
if (idleTimeoutMs && idleTimeoutMs > 0) {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Stream idle timeout: no data received in ${idleTimeoutMs}ms`)), idleTimeoutMs)
  );
  const { value, done } = await Promise.race([reader.read(), timeoutPromise]);
  // ...
}
```

3. 将 `idleTimeoutMs` 从 `stream()` → `iterateAnthropicEvents()` → `iterateSseMessages()` 逐层传递。

**影响**：网关故障不再导致无限阻塞，60s 后主动 abort 并返回错误，让 retry 机制介入。

---

## 5. 压缩系统：熔断逻辑 + 相对有效性判断 + 可见性事件

### 问题

当前压缩系统的三大病灶：

1. **成功但无效被判失败**：判据用绝对值 `tokensAfter >= threshold`，但系统提示和工具 schema 占几万 token（摘要动不了它们），导致"真压缩了、真释放了"但绝对值过不了线 → 误判失败。
2. **全在 tail 里无消息可摘**：触发压缩用 anchor 估算器（含系统提示几万），切分 tail 用 chars/4（只数正文）→ 口径不一致 → `toSummarize.length === 0` → 返回失败。
3. **熔断计数器不重置**：连续 3 次失败（无论是真失败还是结构性无能为力）→ 永久关停压缩 → 长任务只能人工 `/compact` 救场。

### 解决方案

#### 5.1 添加熔断状态变量

在 `coding-agent/src/core/agent-session.ts` 中：

```typescript
// Compaction state
private _compactionConsecutiveFailures = 0;
private readonly _compactionCircuitBreakerThreshold = 3;
private _compactionCircuitBreakerTripped = false;
```

#### 5.2 压缩前检查熔断器

在 `_runAutoCompaction()` 开头：

```typescript
if (this._compactionCircuitBreakerTripped) {
  // Circuit breaker tripped, skip compaction
  return false;
}
```

#### 5.3 压缩后用相对节省比判断有效性

```typescript
// 自动压缩成功后
const savingsRatio = tokensBefore > 0 ? (tokensBefore - estimatedTokensAfter) / tokensBefore : 1;
const isEffective = savingsRatio >= 0.15; // 至少节省 15% 才算有效

if (isEffective) {
  // Effective compaction: reset circuit breaker
  this._compactionConsecutiveFailures = 0;
  this._compactionCircuitBreakerTripped = false;
} else {
  // Compaction ran but was structurally ineffective (e.g. context dominated by system prompt/tools)
  this._compactionConsecutiveFailures++;
  if (this._compactionConsecutiveFailures >= this._compactionCircuitBreakerThreshold) {
    this._compactionCircuitBreakerTripped = true;
  }
}
```

**关键**：
- "成功"和"有效"是两回事：LLM 调用成功但节省比不足 15% 不算有效。
- 结构性无能为力（`preparation === null`，即无消息可摘）不计入失败。
- 手动压缩成功也重置熔断器（给 auto-compaction 提供自愈路径）。

#### 5.4 异常时增加失败计数

```typescript
} catch (error) {
  // True failure (exception): increment failure counter and check circuit breaker
  this._compactionConsecutiveFailures++;
  if (this._compactionConsecutiveFailures >= this._compactionCircuitBreakerThreshold) {
    this._compactionCircuitBreakerTripped = true;
  }
  // ... emit compaction_end with errorMessage
}
```

#### 5.5 增强 compaction_end 事件可见性

更新事件类型定义：

```typescript
| {
    type: "compaction_end";
    reason: "manual" | "threshold" | "overflow";
    result: CompactionResult | undefined;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
    /** Relative savings ratio (0-1), present on successful compactions */
    savingsRatio?: number;
    /** Whether this compaction was deemed effective (>= 15% reduction) */
    isEffective?: boolean;
    /** Whether circuit breaker has tripped after this event */
    circuitBreakerTripped?: boolean;
  }
```

发射事件时携带这些字段，让 UI 能显示：
- 成功：`"Compaction: 45.2K → 12.1K tokens (-73%, effective)"`
- 无效：`"Compaction: 180K → 172K tokens (-4%, ineffective, 2/3 failures)"`
- 熔断：`"Compaction circuit breaker tripped (3 consecutive ineffective attempts). Manual compaction required."`

**影响**：
- 长会话不再因熔断死锁而必死。
- 压缩可见性从"静默黑盒"变为"用户可追踪"。
- 判据从绝对值改为相对比，适应"大系统提示 + 工具 schema"的现实。

---

## 设计原则（可复用）

1. **流式协议用事件自带的 index/id 路由，永不用隐式当前指针**  
   上游会乱序/批量/重发。

2. **全链路 token 估算口径统一**  
   触发条件和执行决策必须用同一个估算器。

3. **"成功" ≠ "有效"；熔断器不能把自己锁死**  
   任何熔断都要保留自愈路径（手动操作或相对有效性重置）。

4. **重试/恢复要有状态、有上限、策略递进**  
   透明重试对上层无感。

5. **顺着模型的习惯设计接口（`file_path` 而非 `path`），别跟模型对着干**  
   弱模型的先验分布比 API 规范更重要。

6. **可观测性要早建**  
   结构化 logger + metrics、模型请求日志、压缩可见性——没有这些，隐蔽 bug 根本定位不到。

---

## 改动文件清单

| 文件 | 变更 |
|------|------|
| `packages/agent/src/harness/tools/grep.ts` | 添加 `prepareArguments` 处理 `query` 别名 |
| `packages/agent/src/agent-loop.ts` | 1) 检测"只有 thinking"注入续写<br>2) `stopReason === "length"` 无工具调用时自动续写 |
| `packages/ai/src/api/anthropic-messages.ts` | 1) 添加 `getStreamIdleTimeout()` 配置函数<br>2) `iterateSseMessages` 包装 `reader.read()` 超时<br>3) 逐层传递 `idleTimeoutMs` 参数 |
| `packages/coding-agent/src/core/agent-session.ts` | 1) 添加熔断状态变量（`_compactionConsecutiveFailures` 等）<br>2) `_runAutoCompaction` 检查熔断器<br>3) 压缩后用相对节省比判断有效性<br>4) 异常时增加失败计数<br>5) 更新 `compaction_end` 事件类型和发射 |

---

## 验证

- **类型检查**：`npm run check` 通过（忽略测试文件的无关错误）
- **功能验证**（需手工测试）：
  - grep 工具接受 `query` 参数
  - 模型只输出 thinking 时自动续写
  - 流式响应 60s 无数据自动 abort
  - 压缩失败 3 次后触发熔断，手动压缩可重置
  - `compaction_end` 事件携带 `savingsRatio`/`isEffective`/`circuitBreakerTripped`

---

## 后续

其他可跟进的改进方向（子 agent 超时可配置、结果拼接完整性、stdout 守卫、进程内 Map 泄漏清理）可作为独立改进实施。本文档聚焦当前 harness 最紧迫的 5 个短板。
