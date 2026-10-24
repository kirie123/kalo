# 模型正文出现压缩摘要式回复

## 症状与历史证据

助手正文突然出现 `<analysis>`、`<summary>` 或 Primary Request and Intent、Optional Next Step 等整篇会话摘要标题，没有工具调用，结束原因为正常 stop。用户容易将其误认为本地自动压缩内容泄漏。

历史排查在 549 个会话文件中记录过 3 例：均为同一自定义 provider 与模型组合，回复约 8k–10k tokens，请求上下文分别约 65k、94k、114k。当时该环境的压缩触发记录约为 183k–191k。数字仅描述当时快照，不作为其他配置的固定阈值。本剧本不分发用户会话 ID、项目名、responseId 或私有网关地址。

## 排查

1. 确认条目是 `type: message` 且角色为 assistant，还是 `type: compaction`。前者来自模型消息通路，后者才是本地压缩记录。
2. 检查相邻事件是否存在 compaction，以及该会话当时的实际压缩阈值和 usage。低于阈值和缺少 compaction 是排查线索，不能单独证明请求中没有其他摘要提示。
3. 将正文与对应压缩记录逐一比对。历史快照里，553 份压缩摘要的文本未在 message 条目中发现相同内容。
4. 在源码和构建产物中检查摘要标题与压缩提示词格式。搜索无匹配只覆盖被检查的文件，不能证明动态扩展、网关或模型绝不可能生成同样内容。
5. 在本地关联时间、provider、模型和 responseId；对外反馈时只提供维护方排查所需的最少信息，不公开完整对话或凭据。

可将下面脚本保存为临时 Python 文件，在实际会话目录中运行。它只输出聚合计数，Windows/macOS 使用同一 Python 路径 API：

```python
import json
from collections import Counter
from pathlib import Path

counts = Counter()
for path in Path.cwd().rglob("*.jsonl"):
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = entry.get("message", {})
        if entry.get("type") != "message" or message.get("role") != "assistant":
            continue
        text = "\n".join(
            block.get("text", "") for block in message.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if "<analysis>" in text and "<summary>" in text:
            counts["summary_shaped_messages"] += 1
print(dict(counts))
```

## 判断与处置

上述历史证据支持：这三条文本经普通模型回复通路进入正文，没有发现本地 compaction 文本被直接复制进正文的证据。模型自行生成、上游网关处理或请求中的其他上下文如何导致该格式，客户端快照不足以确定；没有采集网关内部执行链，不能断言其一定触发了某种 auto-compact。

可以切换模型或路由进行对照，并将脱敏请求信息交给网关维护方。摘要式正文可能继续参与后续上下文，应先保存必要信息再决定是否新开会话，不建议直接编辑或删除活动中的 JSONL 文件。

如需在产品中识别并折叠此类回复，应另写设计并验证误判：用户可能本来就要求生成摘要，不能仅按标题匹配替换正常答案。本剧本只记录排查方法，不实现内容拦截。

## 验证

检查异常回复的事件类型、相邻压缩事件和源码通路；对照路由观察是否复发。未复发只表明本轮未观察到问题，不能证明上游根因已修复。
