# OpenAI-compat 代理的缓存命中率始终显示 0%

## 症状

使用 pz 等第三方 OpenAI-compatible 网关代理 Anthropic 模型（如 claude-opus-5）时，每轮响应的"缓存命中"始终显示 0%，即使对话很长、系统提示很大，缓存命中应该很高。

## 快速排查

1. 确认 provider 在 `models.json` 里配置的 `api` 是 `"openai-completions"`（而非 `"anthropic-messages"`）。
2. 检查网关实际返回的 usage 结构，看是否包含 `prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens` 字段。
3. 如果网关返回的是 Anthropic 原生格式（含 `cache_read_input_tokens` 字段），则是本文描述的问题。

## 根因

`openai-completions` API 的 `parseChunkUsage` 只从以下字段读取缓存命中数：

```
prompt_tokens_details.cached_tokens
prompt_cache_hit_tokens
```

部分 OpenAI-compat 代理（如 `gateway.kotei.com.cn`）内部转发 Anthropic 模型请求，但 usage 字段使用 Anthropic 原生字段名 `cache_read_input_tokens`，而非 OpenAI 格式的 `prompt_tokens_details.cached_tokens`，导致 `cacheRead` 始终解析为 0。

## 修复（分两种情况）

### 情况 A：网关上报了 Anthropic 原生缓存字段

已在 `kalo-harness/packages/ai/src/api/openai-completions.ts` 的 `parseChunkUsage` 函数里补充读取 Anthropic 原生字段：

```ts
const cacheReadTokens =
    rawUsage.prompt_tokens_details?.cached_tokens ??
    rawUsage.prompt_cache_hit_tokens ??
    rawUsage.cache_read_input_tokens ??   // ← 新增：Anthropic-native 代理兼容
    0;
const cacheWriteTokens =
    rawUsage.prompt_tokens_details?.cache_write_tokens ||
    rawUsage.cache_creation_input_tokens ||   // ← 新增：Anthropic-native 代理兼容
    0;
```

## 验证

1. 用 pz/claude-opus-5 发送一段较长的对话（至少 2 轮，系统提示较大）。
2. 第二轮响应底部的"缓存命中"应显示大于 0% 的数值（通常 80%+ 对长上下文有效）。
3. 如果仍然为 0，检查网关是否完全不返回任何缓存字段（此时是网关侧未开启缓存，不是客户端问题）。

## 情况 B：网关的 OpenAI 兼容层完全不报缓存字段（`gateway.kotei.com.cn` 实测属此类）

**症状**：解析修好后命中率仍是 0%。

**判别**：用同一个大前缀连续发两次 OpenAI 兼容请求，直接看网关返回的 usage：

```bash
for i in 1 2; do curl -s -X POST "$BASE/v1/chat/completions" \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" -d @body.json \
  | grep -o '"usage":{[^}]*}'; done
# 实测：{"prompt_tokens":6620,"completion_tokens":4,"total_tokens":6624}  ← 两次完全一样，没有任何缓存字段
```

既无 `prompt_tokens_details.cached_tokens`，也无 `cache_read_input_tokens`（流式带 `stream_options.include_usage` 也一样）。而同一网关、同一前缀走原生 `/v1/messages`：第一次 `cache_creation_input_tokens=6761`，第二次 `cache_read_input_tokens=6761`。

**根因**：OpenAI Chat Completions 的 schema 里没有 prompt cache 的位置，网关的翻译层既不下发 `cache_control` 断点，也不把上游的缓存计数回写成任何字段。所以该路径上**缓存结构性地不可用**，不是解析问题。

**修复**：把该 provider 换成原生 Anthropic 协议。三件事必须同时满足：

```json
{
  "api": "anthropic-messages",
  "baseUrl": "https://gateway.kotei.com.cn/yanjiuyuan",   // 去掉 /v1：SDK 自己拼 /v1/messages
  "authHeader": true                                      // 该网关只认 Authorization: Bearer
}
```

- `baseUrl` 留着 `/v1` 会拼成 `/yanjiuyuan/v1/v1/messages` → 404。
- 不缺 `authHeader` 会拼成 `x-api-key` → 401，详见 [Anthropic 协议网关返回 401](anthropic-gateway-401-bearer-auth.md)。
- 引擎在 `anthropic-messages` 路径下**自动**给 system / 最后一个 tool / 最后一条消息打 `cache_control`（默认 `short` retention），无需额外配置。

**实测（真实多轮会话，同一 session）**：turn1 `cacheWrite=7335` → turn2 `cacheRead=7335` → turn3 `cacheRead=7344`，页脚命中率 ~100%。
