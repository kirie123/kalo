# 工具产出的卡片（产物 / widget 图表）实时流里不显示，重开会话才出现

## 症状

- 模型调用了 `show_widget` / `present_files`，会话 jsonl 里 `details` 落盘完全正常（`"type":"widget"`、`"render_mode":"svg"` 等结构齐全），parse 判据也没问题。
- 但当轮对话里对应的卡片（图表卡 / 产物卡）就是不渲染。
- 关掉再重开这个会话，卡片又出现了。

即"活干完了、工具也调了、卡片却看不到"，且只在实时流里丢、回放不丢。

## 快速排查

1. 先确认不是引擎/契约问题：查最新 `~/.kalo/sessions/*.jsonl`，看那条 toolResult 的 `message.details` 是否齐全。齐全 → 问题在前端 store，不在引擎。
2. 确认 `parseWidget` / `parseArtifacts` 纯逻辑单测通过（本就该过）——说明 bug 不在解析层。
3. 定位到 `chat-store.ts` 的 `tool_execution_end` 分支：看卡片推送是不是写在 `updateToolRecord` 的回调**内部**。

## 根因

`mutateTimeline` 是"快照 → 改 → setState"：

```
const t = [...rt.view.timeline];   // 快照 A
fn(t);
this.setRt(rt, { timeline: t });   // 提交快照 A
```

`updateToolRecord` 本身跑在一次 `mutateTimeline` 里。如果卡片推送写在它的回调内部，就形成**嵌套 `mutateTimeline`**：

1. 外层取快照 A（还没有卡片）。
2. 回调里推卡片 → 内层 `mutateTimeline` 提交快照 B（含卡片）。
3. 回调返回，外层继续用**快照 A** `setState` → 覆盖第 2 步，卡片被静默丢弃。

回放路径（`buildTimeline`）是线性的、无嵌套，所以重开会话卡片又在——这正好解释"只在实时流丢"。

## 修复

把卡片推送移出 `updateToolRecord` 回调：回调只负责算出更新后的记录并经 `let done` 带出；`updateToolRecord` 返回后，在顶层用独立的 `mutateTimeline` 追加产物卡 / widget 卡。

通用规则：**任何"回调里再推 timeline"都要警惕嵌套 `mutateTimeline`**。需要在一次 mutate 里连带做副作用时，要么合进同一个 `fn`，要么把副作用挪到外层 mutate 之后单独提交。

## 验证

- `npx tsc --noEmit`（`kalo-desktop/`）通过。
- 人工复现：让模型出一个 `show_widget` 图表，实时流里卡片应立即渲染，无需重开会话；重开后仍在（回放一致）。
- store 事件应用层耦合 Tauri IPC，属隔离边界，不为此 mock 整个 IPC 层做自动化测试；纯逻辑（`parseWidget`/`parseArtifacts`）的单测继续覆盖解析。
