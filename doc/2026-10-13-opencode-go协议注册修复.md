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
