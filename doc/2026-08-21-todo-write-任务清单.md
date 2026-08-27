# todo_write 任务清单工具

## 问题

kalo 的 agent 做多步任务时，用户看不到"计划"：只能从一条条工具气泡里倒推它打算干什么、干到哪儿了。长任务尤其难受——滚动几屏之后，"它还记得要做第 4 步吗"没有答案。

业界常见做法是给模型一个 `todo_write` 工具，模型每次把**整张清单**重写一遍，UI 分两处渲染：

- 工具行：一行摘要（`3/5 已完成 · 当前任务`），不占地方
- 输入框上方常驻面板：完整清单带状态图标，随下一轮 turn 清空

本文档记录在 kalo 上的等价实现。

## 设计

### 1. 整表替换，而非增量操作

参考实现（`kalo-harness/packages/coding-agent/examples/extensions/todo.ts`）用的是 `action: list|add|toggle|clear` 的动词式 API。这里不采用，改成整表替换：一次调用传完整的 `todos` 数组，覆盖上一版。

原因：动词式 API 让模型必须记住每条 todo 的 id，而 id 只存在于历史工具结果里；一旦上下文被压缩，模型就会 toggle 到错误的 id 上。整表替换没有这个状态，模型每次只需要重新表述当前计划——它本来就知道计划是什么。代价是每次调用的 token 大一点，换来的是不会静默改错。

### 2. 状态存在工具结果的 details 里

`AgentToolResult.details` 会随 toolResult 消息进 session jsonl，也会经 RPC 原样送到桌面端（协议里是不透明的 JsonValue，无需改协议）。所以：

- 分支（branch）时清单自动回到那个时间点的状态，不需要额外的持久化
- 桌面端读 `rec.result.details.todos` 就能拿到快照，零协议改动
- 引擎侧不需要维护内存状态，`execute` 是纯函数

历史重放（`buildTimeline`）走同一条路，resume 一个会话也能正确恢复清单。

### 3. 单一 in_progress

清单里最多一条 `in_progress`。多条并行的写法（`allowParallelInProgress` 开关）对 kalo 没意义：kalo 的子 agent 是 `agent` 工具单次调用，不是长期并行的 lane。违反时直接报错而不是静默修正——模型能从错误里学会规则，静默修正只会让它一直错下去。

### 4. 工具名用 `todo_write` 而非 `todowrite`

`packages/ai/src/api/anthropic-messages.ts` 有个 stealth 映射表，会把 `todowrite` 改写成 Claude Code 的 `TodoWrite` 再发出去。带下划线的 `todo_write` 不在表里，原样透传。避免踩这个坑。

## 实现

### 引擎侧：`kalo-harness/packages/coding-agent/src/extensions/todo/index.ts`

内置扩展（`builtInExtensions`，hidden），注册一个工具：

```ts
todo_write({ todos: [{ content: string, status: "pending"|"in_progress"|"completed" }] })
```

校验：content 非空去重、in_progress 至多一条。校验失败抛错（走 isError 路径），不写入。

返回：

```ts
{
  content: [{ type: "text", text: "任务清单已更新：2 已完成，1 进行中，1 待办。" }],
  details: { todos, counts: { pending, inProgress, completed } },
}
```

带 `promptSnippet` + `promptGuidelines`——没有 promptSnippet 的自定义工具不会出现在系统提示词的 Available tools 段里。

TUI 的 `renderCall`/`renderResult` 也一并给了，这样 pi 命令行模式下同样能看。

### 桌面侧

**a) chat-store 的 todos 投影**

`SessionView` 加一个 `todos: TodoItem[]` 字段：

- `tool_execution_end` 且 `toolName === "todo_write"` 且非 error → 覆盖为 `details.todos`
- `sendPrompt` 且当前不在流式中 → 清空（对应 turn/start 语义：新一轮提问意味着旧计划作废）
- `buildTimeline`（历史重放）→ 扫最后一条 todo_write 结果作为初值

清空点选在 `sendPrompt` 而不是 `agent_start`，是查过引擎调用链之后的结论：`agent-session.ts` 的 `_runAgentPrompt` 里有一个 `while (await this._handlePostAgentRun()) await this.agent.continue()` 循环，重试、compaction、以及 agent_end 阶段排队的消息都会让它再进一次循环，而每次进入 `runAgentLoop`/`runAgentLoopContinue` 都会重新发一次 `agent_start`。也就是说 `agent_start` 并不是「一次提问一次」，挂在它上面清空会在长任务跑到一半、正好触发一次压缩或重试时把清单抹掉——恰恰是清单最有用的时候。

`sendPrompt` 里还要用 `!isStreaming` 过一道：流式中发的是 steering（`streamingBehavior: "steer"`），那是对当前这轮的追加指令，不是新问题，计划要留着。

清空也不放在 `agent_settled`：一轮跑完时清单应该还留在屏幕上让用户看结果，直到下一次提问才作废。

**b) 工具气泡 `ToolCallGroup.tsx`**

四个扩展点各加一条，和现有工具一致：

- `TOOL_VERBS`：`{ verb: "更新", noun: "次任务清单" }`
- `TOOL_CHIPS`：`"Todo"`
- `rowLabel`：`3/5 已完成 · <当前进行中的任务>`
- `ToolCallDetail`：新分支，渲染带状态图标的清单

连续多次 `todo_write` 会被 chat-store 合并成一个 group（每次调用一行）。清单反复更新时这会堆出很多行，所以**只有最后一行默认展开**，历史行折叠成一行摘要——用户想看演进过程还能点开，但默认视图干净。实现上给 `ToolCallRow` 传一个 `isLast` prop。

**c) 常驻面板 `TodoPanel.tsx`**

挂在 `ChatView` 里 `MessageList` 和 `InputBox` 之间，跟着 composer 一起 zoom。清单为空时不渲染。

默认折叠成一行（`任务清单  2 已完成 · 1 进行中 · 1 待办`），点开看全部。折叠时额外显示当前 `in_progress` 那条的文本——这是用户最想知道的一条信息，不该需要点一下才能看到。

图标沿用桌面端既有的手写 inline svg 风格（无图标库）：completed 实心勾圈、in_progress 复用 `.spinner`、pending 虚线圈。

## 不做的事

- 不做 `/todos` 斜杠命令：桌面端已有常驻面板，命令是 TUI 的形态
- 不改协议：details 已经是不透明 JsonValue，够用
- 不做跨会话持久化：清单是一轮工作的草稿，不是长期记忆（长期记忆有 memory 扩展）
