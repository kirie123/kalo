# ContextRing 加载历史会话后始终显示 "–"

## 症状

打开一个历史会话，输入区左侧的上下文圆环显示 `–`（而非百分比），悬停提示为"暂无上下文数据（开始对话后显示）"。新发一条消息后恢复正常，但在首次输入前圆环一直为空。

## 快速排查

1. 确认是历史会话（已有 `.jsonl` 文件），而非新建会话——新建会话无消息时显示 `–` 属正常。
2. 如果新发消息后圆环正常出现，则是时序问题而非数据缺失。
3. 查 `chat-store.ts` 的 `handleAgentEvent` → `session_info_changed` 分支，确认是否调用了 `refreshContextUsage`。

## 根因

`resumeSession` 走两阶段加载：先渲染历史时间线，再后台 spawn 引擎。`attachSession` 完成后立即调用 `refreshContextUsage`（`chat-store.ts:974`），此时引擎刚启动，harness 的 `this.messages` 尚未从 `.jsonl` 文件恢复，`estimateContextTokens` 算出 0 tokens，返回 `{ tokens: 0, percent: 0 }`——前端圆环空转，显示 `–`。

后续没有 `agent_end` 或 `compaction_end` 触发再次刷新，所以 0 一直停在那里直到用户发消息触发新的 LLM 调用。

## 修复

在 `kalo-desktop/src/lib/chat-store.ts` 的 `session_info_changed` 事件分支里加一行刷新调用：

```ts
case "session_info_changed":
  if (rt.pending && ev.name) rt.pending = { ...rt.pending, title: ev.name };
  this.setRt(rt, { sessionName: ev.name });
  void this.refreshContextUsage(rt);   // ← 新增
  break;
```

`session_info_changed` 是引擎把历史消息加载进内存后必然触发的事件，此时 `estimateContextTokens` 才能得到真实值。

已在 `chat-store.ts:1643` 处应用此修复。

## 验证

1. 打开任意历史会话（有若干条对话记录的 `.jsonl`）。
2. 等待引擎加载完成（侧边栏会话名称更新），不发任何消息。
3. 圆环应显示正确的百分比（而非 `–`），悬停提示应显示 `上下文：XXK / XXXK tokens（N%）`。
