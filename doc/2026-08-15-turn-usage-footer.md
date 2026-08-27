# 每轮 token 消耗与缓存命中率页脚

日期：2026-08-15
状态：已实现

## 需求

每轮（turn）执行结束后，在该轮最后一条 assistant 消息末尾显示一行小字：输入/输出 token 数与缓存命中率。用户关注成本与缓存效率。

## 数据来源

引擎每个 assistant 消息的 `message_end` 事件自带 `usage`（`input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens`），桌面端无需改引擎。

## 设计

- **按轮聚合**：一轮 agent 执行可能含多次 LLM 调用（工具循环），逐条消息显示会很碎。`ChatStore` 在 assistant `message_end` 时累加 usage，`turn_end` 时把聚合结果挂到该轮最后一条 assistant 时间线条目（`AssistantEntry.usage`）并清零累加器。
- **缓存命中率** = `cacheRead / (cacheRead + input)`（缓存读取占全部输入侧 token 的比例）；分母为 0 时不显示百分比。
- **展示**：`AssistantMessage` 底部一行 dim 小字：
  `本轮 tokens：输入 2.0K · 输出 12 · 缓存命中 94%`
- **历史会话**不回溯聚合（逐条 usage 仍在消息里，但页脚只覆盖实时轮次）——后续有需要再加。

## 边界情况

- 中途 abort：`turn_end` 照常触发，显示已消耗部分。
- 崩溃恢复（handleEngineExit）：累加器随会话生命周期重置。
- 无 usage 的消息（如部分错误路径）不参与聚合；整轮无数据则不显示页脚。
