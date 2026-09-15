# 每轮 token 消耗与缓存命中率页脚

日期：2026-08-15（2026-09-16 增补调用次数）
状态：已实现

## 需求

每轮（turn）执行结束后，在该轮最后一条 assistant 消息末尾显示一行小字：输入/输出 token 数与缓存命中率。用户关注成本与缓存效率。

## 数据来源

引擎每个 assistant 消息的 `message_end` 事件自带 `usage`（`input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens`），桌面端无需改引擎。

## 设计

- **按轮聚合**：一轮 agent 执行可能含多次 LLM 调用（工具循环），逐条消息显示会很碎。`ChatStore` 在 assistant `message_end` 时累加 usage，`turn_end` 时把聚合结果挂到该轮最后一条 assistant 时间线条目（`AssistantEntry.usage`）并清零累加器。
- **缓存命中率** = `cacheRead / (cacheRead + input)`（缓存读取占全部输入侧 token 的比例）；分母为 0 时不显示百分比。
- **展示**：`AssistantMessage` 底部一行 dim 小字，文案由 `src/lib/run-usage.ts` 的 `formatRunUsage()` 生成：
  `本轮累计（3 次调用）：输入 2.0K · 输出 0.0K · 缓存命中 94%`
- **历史会话**不回溯聚合（逐条 usage 仍在消息里，但页脚只覆盖实时轮次）——后续有需要再加。

## 为什么要显示调用次数（2026-09-16）

原文案 `本轮 tokens：输入 793K` 在 200K 窗口的模型上会被读成统计 bug。实际是口径问题：

- 页脚是**一个 run 内所有 LLM 调用的累加**，每次调用都要把整个上下文重发一遍，所以累计输入天然可以数倍于窗口（793K ≈ 4 × 198K）。
- 输入框上的 `198K / 200K`（`ContextRing`）是另一个口径：来自引擎 `get_session_stats` 的**当前上下文快照**，受窗口约束。两个数字同屏出现且相差数倍，没有线索可供区分。

因此 `TurnUsage` 增加 `calls` 字段（`onMessageEnd` 里每条带 usage 的 assistant 消息 +1），页脚改为 `本轮累计（N 次调用）`。

附带收益：**空转重试变得可见**。压缩失败导致的 overflow 重试循环表现为「N 次调用、输出 0.0K、缓存命中 100%」——调用次数缺失时这种烧钱空转在界面上无从察觉。

格式化逻辑抽到 `src/lib/run-usage.ts`（含 `formatK` / `cacheHitRate` / `formatRunUsage`）以便单测，`ContextRing` 与 `AssistantMessage` 共用 `formatK`；测试见 `src/lib/run-usage.test.ts`。

## 边界情况

- 中途 abort：`turn_end` 照常触发，显示已消耗部分。
- 崩溃恢复（handleEngineExit）：累加器随会话生命周期重置。
- 无 usage 的消息（如部分错误路径）不参与聚合；整轮无数据则不显示页脚。
