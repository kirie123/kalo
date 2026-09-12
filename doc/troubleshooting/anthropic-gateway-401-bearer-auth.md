# Anthropic 协议网关返回 401（网关只认 Authorization: Bearer）

## 症状

自定义 Provider 按 `api: "anthropic-messages"` 配好 `baseUrl` + `apiKey` 后，会话里模型**没有任何输出**，引擎侧报错只有一行：

```
401 status code (no body)
```

换用另一个网关（或把同一网关改成 `api: "openai-completions"`）却正常。

相关：[OpenAI-compat 代理的缓存命中率始终显示 0%](openai-compat-proxy-cache-hit-always-zero.md)（同属「第三方网关与官方协议细节不一致」家族，症状不同）。

## 快速排查

用 curl 直接对网关分别试两种鉴权头（不要经过桌面端，隔离客户端因素）：

```bash
BASE="https://gateway.example.com/yanjiuyuan"; KEY="***"
B='{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'

# 1) Anthropic 官方头
curl -s -o /dev/null -w "x-api-key  -> %{http_code}\n" -X POST "$BASE/v1/messages" \
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "x-api-key: $KEY" -d "$B"

# 2) Bearer 头
curl -s -o /dev/null -w "Bearer     -> %{http_code}\n" -X POST "$BASE/v1/messages" \
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "authorization: Bearer $KEY" -d "$B"
```

判读：

- 1) 401 且响应头含 `www-authenticate: Key realm=<网关名>`、body 为空 → 命中本文。
- 2) 200 → 网关支持 Anthropic Messages 协议，只是鉴权头非标准。
- 2) 也 401/404 → 是网关不通或路径不对（`/v1/messages` 不存在），不是本文问题。

顺带可确认协议是否真支持流式与工具：加 `"stream":true` 应返回 `event: message_start` / `content_block_delta` 等标准 SSE。

## 根因

网关只校验 `Authorization: Bearer`，而引擎的 `anthropic-messages` 适配器走 Anthropic 官方 SDK，`apiKey` 一律以 `x-api-key` 发送（`kalo-harness/packages/ai/src/api/anthropic-messages.ts` 的 `createClient()`，仅 OAuth / Copilot 分支才用 `authToken`）。两侧都「按自己的规范」实现，于是必然 401。

**注意**：401 是立刻返回的，不是网络卡住。界面表现为「无输出」时容易被误判成模型响应卡顿。

## 修复

在 `~/.kalo/agent/models.json` 该 provider 上加一行：

```json
{ "authHeader": true }
```

引擎会同时发送 `x-api-key` 与 `Authorization: Bearer <apiKey>`（`provider-composer.ts` 的 `withConfiguredAuth()`）。

`authHeader` 是**按 provider** 的开关：官方 Anthropic 端点、其他网关都不要开，保持默认即可。

### 已知陷阱：桌面端会抹掉这个字段

桌面端（截至本文）**未提供 `authHeader` 开关**，而且 `ProviderEditModal` 保存时会**整条重写** provider 条目（只保留每个模型的元数据），因此：

- 在设置页/「添加模型」弹窗里**编辑过该 provider**（包括用「已有 Provider」一键填充后再保存）→ 手改的 `authHeader` 被静默删除，**401 复发**。
- 设置页的「删除」只删单个 key，不受影响。

规避：需要编辑该 provider 时，先用弹窗改其他字段，保存后**再把 `authHeader: true` 加回**；或另建一个不受弹窗管理的 provider 名。彻底修复需给桌面端表单加该勾选框并保留未管理字段（已评估，暂未做）。

## 同一网关可能直接拒绝 pi 内核（400，与鉴权无关，**通常几分钟后自行恢复**）

鉴权修好后仍可能拿到这种 400：

```
Requests from the pi coding agent framework are not supported. We do not accept
requests from third-party agent frameworks, as the underlying Claude subscriptions
are subject to Anthropic's usage policy. Direct API usage, Claude Code CLI, and
Codex CLI are supported. (request id: ...)
```

**判别：拦的是 system prompt 指纹，不是协议或鉴权**（`gateway.kotei.com.cn` 实测，同一 key、同一 provider 配置）：

| 变量 | 结果 |
|---|---|
| pi 默认 system prompt + 15 个工具 | 400 拒绝 |
| pi 默认 system prompt + **关闭工具**（`--no-tools`） | 400 拒绝（说明与工具无关） |
| 自定义 system prompt + 15 个工具 | 200 通过 |

即只要 system prompt 不是 pi 那一套就不能识别。注意：

- 这是**上游策略且会波动**：实测同一网关、同一配置，上午能跑（含缓存命中），几小时后开始全量拦截，再过一小时又自行恢复。**遇到这个错先等 5～10 分钟重试、看看是不是上游在抽风，不要急着改配置**（改了也没用，因为拦的不是配置）。
- 想确认到底是上游在拦还是自己配错了：用 `--system-prompt "You are a helpful assistant."` 跑一次，通过则说明鉴权/协议/路径都没问题，完全是提示词指纹在拦。
- 换成非 pi 提示词、或照搬 Claude Code 的提示词，**属于绕开网关明示的使用政策**，不建议作为常规手段；正路是让网关管理员加白名单，或换上游。
- 拦的时候该网关对 kalo 桌面端（走 pi 内核）不可用，与 `api` / `authHeader` / `baseUrl` 怎么配无关。

## 顺带分清 401 / 403 / 404 / 503

修好鉴权后如果仍然失败，先分清是哪一类（同一 key 直连网关逐个试）：

| 返回 | 含义 |
|---|---|
| 401 | 鉴权头不对（本文）。 |
| 403 `AccessDenied`（可能出现阿里云 model-studio 字样） | 鉴权已通，但**该 key 无权访问这个模型**：上游未开通/未授权，找网关管理员，客户端无法解决。 |
| 404（空 body） | **网关不认识这个 model id**（不是你写错了前缀，而是网关没上架）。 |
| 503 `Service temporarily unavailable` | id 存在，上游临时不可用，重试即可。 |

## 验证

```bash
pi-x86_64-pc-windows-msvc.exe --print --no-session --model pz/claude-opus-5 "say hi"
```

返回模型正文而非 `401 status code (no body)`；再让它跑一次工具调用（如 `echo TOOLOK`）确认 tool_use 往返正常。

> 排错用临时配置时可用 `KALO_CODING_AGENT_DIR=<临时目录>` 指定独立的 `models.json`，避免动到用户配置。
