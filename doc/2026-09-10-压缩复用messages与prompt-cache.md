# 压缩与 prompt cache：复用 messages 的可行性

## 背景

排查「主动/自动上下文压缩很慢」时提出一个改造设想：把摘要提示词改成以 user message 形式追加在对话末尾，复用主对话的 `messages` 数组，从而命中 provider 的前缀缓存（prompt cache），省掉每次压缩重新 prefill 十几万 token 的开销。

本文记录对该设想的实测。结论：**方案在体积上完全可行，是否有收益取决于 provider 是否真的支持前缀缓存。**

## 当前实现为什么拿不到缓存

`packages/coding-agent/src/core/compaction/compaction.ts` 的 `completeSummarization()` 有三处主动放弃缓存：

1. `cacheRetention: "none"` —— 显式关闭缓存写入
2. 每次生成新的 `sessionId` —— 强制路由到新会话，不复用既有前缀
3. `serializeConversation()` 把 N 条消息压平成 1 条巨型 user 文本

第 3 条是根本原因。即使前两条改掉，序列化产出的 token 序列与主对话**从第 0 个 token 就分叉**，前缀缓存必然 miss。所以「只改提示词位置」不足以拿到缓存，必须连带复用原始 `messages`。

## 实测一：当前网关不存在前缀缓存

环境：provider `pz`（OpenAI 兼容网关 `gateway.kotei.com.cn`），模型 `claude-opus-5`。

方法：构造约 47K token 的前缀，交替执行两组请求以排除网关抖动。

- WARM：固定同一前缀，先预热一次，之后每轮复用该前缀 + 追加一条不同的短 user 消息
- COLD：每轮使用一个全新的、从未发送过的唯一前缀（随机 tag 替换）+ 同样的追加消息

两组均设 `max_tokens: 40`、`thinking: {"type": "disabled"}`，避免输出长度差异污染耗时。

| 轮次 | WARM（复用前缀） | COLD（全新前缀） |
| --- | --- | --- |
| 0 | 3.59s | 8.81s |
| 1 | 11.25s | 4.47s |
| 2 | 4.15s | 7.32s |
| 3 | 6.58s | 6.29s |
| **均值** | **6.39s** | **6.72s** |

结论：两组无差异（组内方差远大于组间差异，WARM1 的 11.25s 慢于所有 COLD 轮次）。配合另两条旁证：

- 响应 `usage` 中无任何 cache 相关字段
- 重复发送完全相同的请求，`prompt_tokens` 一字不减（46353 → 46353）

判定：该网关不支持或不回报前缀缓存。压缩耗时全部是实打实的 prefill，约 3.5K tok/s，180K 上下文约 60s。

相关既有记录见 `doc/troubleshooting/openai-compat-proxy-cache-hit-always-zero.md`。

## 实测二：复用 messages 不会超窗

### 度量口径（关键）

`prepareCompaction()` 只处理**上一次压缩边界之后的增量**，不是整个会话历史：

```
boundaryStart = 上一次 compaction 的 firstKeptEntryId 所在位置   // compaction.ts:766-771
for (let i = boundaryStart; i < historyEnd; i++)                // compaction.ts:789
```

度量时必须按每个压缩点还原当时的 live window（`上一次边界 → 本次压缩点`）。若直接遍历整个 JSONL 累加，会把十几个压缩周期的内容叠在一起，得到严重虚高的数字。

### 结果

还原 cowith 会话 30 个压缩点 + kalo-work 会话 3 个压缩点，共 33 次真实压缩：

| 压缩点 | live 消息数 | 当前序列化 | 复用原始 messages | 比值 | 触发时 tokensBefore |
| --- | --- | --- | --- | --- | --- |
| cowith @235 | 235 | 161K | **198K（最大）** | 1.23x | 901794 |
| cowith @549 | 341 | 120K | 168K | 1.40x | 183961 |
| cowith @1598 | 185 | 87K | 97K | 1.10x | 186108 |
| cowith @3478 | 336 | 45K | 45K | 1.00x | 183147 |
| kalo @88 | 88 | 24K | **142K** | **6.06x（最大比值）** | 203858 |
| kalo @208 | 125 | 54K | 177K | 3.25x | 184857 |
| kalo @460 | 266 | 73K | 184K | 2.52x | 189211 |

要点：

- **33 次中没有一次复用体积超过 200K 窗口**，最大 198K（cowith @235）
- `tokensBefore` 几乎每次都是 183K-190K，即压缩总在接近窗口时触发；主对话既然装得下，复用它自然也装得下
- 膨胀比中位数约 1.08x，cowith 的 30 次里有 20 次落在 1.0-1.2x

结论：**超窗不成立**，方案在体积上可行。

### 尾部风险：膨胀而非超窗

kalo @88 的 6.06x（24K → 142K）说明当 live window 里堆积大量长工具结果时，放弃 `TOOL_RESULT_MAX_CHARS = 2000` 截断会显著增加 prefill 量。142K 仍在窗口内，但相比当前的 24K 多付近 6 倍 prefill 成本。

这决定了收益方向完全由 provider 决定：

- 支持前缀缓存（原生 anthropic）：复用后绝大部分前缀命中，膨胀部分几乎不额外收费 → 净赚
- 不支持缓存（当前 pz 网关）：膨胀部分全额 prefill，1.1x-6x 不等 → 净亏，比现在更慢

### 附带发现

thinking 文本在 live window 中占比极小，且与 provider 强相关。`pz` 走 openai-completions 时 thinking 不落盘（上述会话统计均为 0）。此前「thinking 撑大压缩 prompt」的猜测在当前 provider 下不成立。

## 结论与实施状态

方案已实施，见 `doc/2026-09-10-压缩复用messages命中缓存.md`：新增 `compaction.reuseMessages`，默认 `true`。实施要点：

1. 复用主对话 `messages` 数组，末尾追加一条摘要指令 user 消息，替代 `serializeConversation()` 压平
2. 打开 `cacheRetention`，复用主会话 `sessionId`（去掉 `completeSummarization()` 中的两处主动放弃）
3. 保留 `serializeConversation()` 作为回退路径，在 provider 不支持缓存时通过 `reuseMessages: false` 继续走截断模式，避免多付膨胀出来的 prefill
4. 用实测一的 WARM/COLD 交替法验证目标 provider 缓存确实生效，再决定是否保持默认开启

注意第 3 点：回退判据是「provider 是否支持缓存」，而非「是否超窗」——实测已证明超窗不会发生。

在当前 `pz` 网关上（实测无缓存），建议显式设 `reuseMessages: false`。

## 已实施的相关改动

本次未改压缩的缓存与序列化逻辑。同期已落地的独立改动见 `doc/2026-09-10-压缩独立thinking等级.md`：压缩使用独立 thinking 等级，默认 `off`，不再继承会话等级。该改动在原生 anthropic 路径上可省下 16384 token 的思考预算；在 `pz` 网关上实测约省 5%-8% 耗时（60s 量级请求约省 3-5s）。

## 复现方法

缓存探测（WARM/COLD 交替）：构造约 47K token 前缀，WARM 组固定前缀预热后复用，COLD 组每轮用随机 tag 替换前缀中的标识串生成全新前缀，两组交替发送，比较均值而非单次耗时。请求需设小 `max_tokens` 并关闭 thinking，否则输出长度差异会淹没缓存效果。

体积量化：遍历会话 JSONL，定位所有 `type === "compaction"` 条目；对每个压缩点，取 `上一次压缩的 firstKeptEntryId 位置 → 本次压缩点` 作为 live window，在该区间内对 `role === "toolResult"` 分别累计原始长度与 `min(长度, 2000)`，二者比值即膨胀倍数。压缩条目上记录的 `tokensBefore` 可用于交叉验证窗口占用。
