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

## 修复

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
