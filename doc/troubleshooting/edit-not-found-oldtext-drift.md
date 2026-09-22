# edit 报 Could not find ...（oldText 与文件字符漂移）

## 症状

`edit` 工具失败，报：

```
Could not find the exact text in <path>. The old text must match exactly including all whitespace and newlines.
```

或多 edit 时 `Could not find edits[i] in <path>. ...`。模型常据此误判为「中文文件不能 edit」「CRLF 文件不能 edit」，放弃 edit 改用 `write` 全量重写——代价大、有丢内容风险。

## 原因

不是中文、也不是 CRLF 的问题。匹配管线是策略阶梯（`exact` → `fuzzy` → `trimmed` → `whitespace` → `anchored`，见 `doc/2026-09-21-edit-匹配容错增强.md`），已经容忍：CRLF（每行 `trimEnd` 会把 `\r` 裁掉）、行尾空白、全角/智能引号、破折号类字符、特殊空格，以及缩进差异（2 空格 vs 4 空格 / tab）、行内空白排布差异、多行块首尾锚定、中间个别行不同的情况。

真正的原因几乎总是**模型重建 oldText 时的字符级漂移**：多一个字母、少一个空格、行号拼接错误等。

真实样本（2026-09-17 cowith 会话，`router_agent.py`）：

| 侧 | 内容 |
|---|---|
| 文件 | `挂在 /internal/rooms/{room_id}/... 下，不进 openapi。` |
| oldText | `挂在 /internal/rooms/{room_id}/... 下，不进 openapi。n` |

逐字核对（python 取 JSONL 里的 `oldText` 与文件行比对码点）：

- oldText 在 `0x3002`（。）后多了 `0x6e`（`n`）；
- `oldText.rstrip("n") == file_line` 为真 → 唯一差异就是这个 `n`。

同一会话里连续失败 3 次，漂移点各不相同（`spawn_replan` 导入行、`\texports_at: string;` 空白、上述 `n`），说明不是网关系统性改写转义，是模型重建文本的自然误差。

## 修复

2026-09-21 起，匹配失败时追加诊断：最近匹配区域（行号 + 相似度）、首个差异行两侧内容、多/少尾部字符、下一步建议。设计与实现见 `doc/2026-09-21-edit-匹配失败诊断.md`。

同版本还上线了容错阶梯（缩进 / 行内空白 / 块锚点）：能靠归一化定位的会直接成功，成功消息里标 `(approximate match: ...)` 提醒复核；本样本这种真正的字符漂移不受影响，仍走下面的诊断。

上述样本现在报：

```
Could not find the exact text in router_agent.py. The old text must match exactly including all whitespace and newlines.
Closest match: lines 3-5 (99% similar).
  line 3 file   : `挂在 /internal/rooms/{room_id}/... 下，不进 openapi。`
  line 3 oldText: `挂在 /internal/rooms/{room_id}/... 下，不进 openapi。n`
The oldText line has 1 extra trailing character that is not in the file: "n".
Re-read the file with the read tool, then retry with text copied verbatim from the file.
```

模型据此可以直接定位到多出来的字符，不再需要猜测「文件类型不支持」。

## 回放验证（2026-09-21）

把该会话里 3 次真实失败调用的参数（`extract_edit_arg.py` 同源脚本从 JSONL 提出）对当前仓库状态重跑匹配阶梯，三例全部仍判未命中，且**都不是缩进/行内空白类漂移，而是内容本身不同**：

| JSONL 行 | 文件 | 文件侧实际行 | oldText | 相似度 |
|---|---|---|---|---|
| 525 | `mission/service.py` | `return await self._opening_reply(source, always=always)` | `return None` | 76% |
| 531 | `ack_poller.py` | `from app.mission.background import spawn_compile, spawn_replan` | `from app.mission.background import spawn_replan` | 76% |
| 2957 | `internal-api.ts` | `sha256: string;` | `exports_at: string;` | 88% |

这正是阶梯应有的行为：531 那例若按「行内近似」硬套，会把同行的 `spawn_compile` 一起改掉；真正的漂移只能靠诊断把文件侧实际行摆出来、由模型重读后修正。注意第 3 例的文件在回放当天已被其他会话改过，不代表会话当时的行号。

## 排查手法

- **看行尾/不可见字符**：`cat -A <file>`（`^M$` = CRLF，`^I` = tab）。不要用 `file` 或 `grep -c $'\r'` 判断行尾，本机（Git Bash + Windows）都不可靠。
- **精确比对 oldText 与文件行**：从会话 JSONL 取出 `oldText`（`toolCall.arguments.edits[].oldText`），打印码点列表 `[hex(ord(c)) for c in line]` 再比对。**不要靠肉眼**：终端 mojibake 会把 `挂在`(U+6302) 显示成类似 `按在`(U+6309) 的样子，本次排查就踩过这个坑。
- **确认是哪一步失败**：`packages/coding-agent/src/core/tools/edit-diff.ts` 里 `applyEditsToNormalizedContent` 按 `EDIT_MATCH_STRATEGIES` 逐级尝试（策略定义与定位在 `edit-match-strategies.ts`）；诊断由 `edit-diff-diagnostics.ts` 的 `describeClosestMatch` 生成，测试见 `test/edit-diff-not-found-diagnostics.test.ts`。
- **旧报错前缀仍保留**（`Could not find the exact text` / `Could not find edits[i]`），用前缀过滤日志的脚本不受影响。