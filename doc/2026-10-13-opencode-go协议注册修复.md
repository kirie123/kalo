# OpenCode Go 模型目录与协议注册一致性

日期：2026-10-13

## 问题

模型生成器已按上游 `@ai-sdk/google` 将 OpenCode Go 的 Gemini 模型映射为 `google-generative-ai`，但 provider 工厂的类型和协议路由只包含 Anthropic、OpenAI Completions、OpenAI Responses。模型数据校验通过后，AI 包 TypeScript 构建在 `Object.values(OPENCODE_GO_MODELS)` 报 TS2322。在线生成和离线构建都会受影响。

## 方案

在 `opencode-go.ts` 注册已有的 Google Generative AI lazy adapter，并将返回类型纳入该 API；让 `createProvider` 从完整配置推导泛型，与 OpenCode Zen 的实现保持一致。不修改生成模型目录，不删除 Gemini，不通过类型断言隐藏路由缺失。鉴权继续使用现有 OpenCode API key，endpoint 继续取模型目录中的 Go URL。

增加无网络协议分派回归测试，覆盖四种 API（包括构造的 Google 模型），避免上游目录暂时移除模型后丢失 Google 分派覆盖。测试同时检查当前目录各 API 都可路由。

此改动为纯 TypeScript 协议注册，不涉及 shell、进程或路径，Windows/macOS 行为相同。npm 的 `min-release-age` 配置警告独立于本次 TS2322，保持原有依赖策略。

## 验证

Windows 本机验证结果：

- OpenCode Go 协议分派专项：5/5 通过，使用 mock adapter，不请求真实服务。
- AI 包 `npm run build:offline`：通过。
- harness 根 `npm run build:offline`：全部通过，覆盖 tui、telemetry、ai、agent、sqlite-node、protocol、client、server、coding-agent 及资源复制。
- `npm run check`：格式、依赖 pin、TS import、shrinkwrap、install-lock 通过；全仓 TypeScript 仍有 34 条现有测试与当前模型目录不匹配的错误，本次 provider 与新增测试无类型诊断。后续 browser smoke 独立执行通过。不能记为全仓 check 通过。
- 本次未重新在线生成模型目录、未打包原生 sidecar 或桌面安装包、未提交。源码构建通过不等于在线服务或安装包验收。

2026-10-24 整理复验：协议分派 5 项测试再次通过，源码与测试整理入库；本轮未重新在线生成模型目录或打包 sidecar。harness check 仍在上述既有模型目录测试的 34 条类型错误处停止，不能记为全仓通过；browser smoke 独立执行通过。

## 2026-10-24 模型目录测试修复方案

34 条类型错误来自测试仍引用已经移出当前目录的模型标识，导致协议泛型退化为联合类型，连带出现 compat 字段不可访问。目录断言和按环境变量启用的服务测试改用目录内明确存在的同类模型：Together Kimi K3、OpenRouter Sonnet 4.6、NVIDIA Nemotron 3 Ultra。Fireworks 同时保留 Anthropic Messages 与 OpenAI Completions 两条协议覆盖，分别检查当前 GLM 5.3 的目录配置及 Kimi K3 的 OpenAI 请求格式。

旧版 OpenCode Go Kimi K2.6 的 thinking 开关、reasoning 字段重放和不支持长缓存仍属于现有协议兼容行为。将该历史模型的测试数据固定为显式、强类型 fixture，不再要求远端当前目录仍上架它；继续检查原有请求字段，不删除用例。补充当前 Go 模型的 thinking 档位断言，区分当前目录契约与历史协议回归。

不修改生成模型文件，不增加宽泛字符串索引或 any 来绕开模型标识约束。测试通过 mock adapter、请求构造中断或本机 HTTP 服务验证；凭证型测试只做收集校验并在隔离凭证环境跳过，不请求真实服务。改动仅影响测试与文档，Windows/macOS 使用相同类型和请求断言。

验证结果：harness 根 `npm run check` 全部通过，包括 Biome、依赖 pin、TS import、shrinkwrap、install-lock、全仓 TypeScript 与 browser smoke；原 34 条诊断归零。16 个改动测试文件在临时 HOME/USERPROFILE、无 API key/OAuth 文件并禁用本地模型发现的子进程中运行，131 项通过，665 项真实服务或本地模型用例按原条件跳过。没有改动跳过条件，没有删除请求或响应断言；新增当前 Go Kimi K3 的档位检查，并在 max_tokens 用例中同时覆盖当前目录与历史 fixture。

此记录不代表真实服务或 macOS 运行验收。npm CLI 仍提示既有 `min-release-age` 配置识别警告；保留依赖安装年龄策略，不将该配置提示计为 TypeScript 错误。
