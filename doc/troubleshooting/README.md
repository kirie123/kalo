# Troubleshooting 调试剧本库

记录**复现过两次以上**的调试陷阱。一次性问题留在 git 历史，不要进这里。

## 使用方式

遇到报错/异常行为，先看这里的症状索引；命中就按剧本走。排查完如果发现了新模式，按「准入标准」补一条。

## 准入标准

只记录：
- 复现过 2 次以上（或大概率复发）的失败模式
- 有真实证据支撑（具体报错、日志片段、复现步骤）
- 有明确修复与验证方法

## 条目格式

每个剧本一个文件，统一结构：

```markdown
# <症状一句话标题>

## 症状
报错信息 / 异常行为（贴关键片段）

## 快速排查
1. 先查什么
2. 再看什么

## 根因
为什么发生

## 修复
怎么改

## 验证
怎么确认修好了
```

## 剧本索引（按域）

### 桌面端（kalo-desktop）
- [cargo check 报 os error 32（文件被运行中的 kalo 锁住）](cargo-file-locked-os-error-32.md)
- [ContextRing 加载历史会话后始终显示「–」（上下文长度不刷新）](context-ring-shows-dash-on-history-session.md)
- [自定义 Provider 的模型「读不到图」（模型定义没声明 image）](custom-provider-image-input.md)
- [从 UI 建的模型不思考、读不到图、输出被截短、手工字段被抹（模型定义缺能力字段）](custom-provider-model-capabilities.md)

### 引擎（kalo-harness / sidecar）
- [启动后提示「引擎未响应」（解析到了其他平台的 sidecar 二进制）](engine-unresponsive-wrong-platform-binary.md)
- [OpenAI-compat 代理的缓存命中率始终显示 0%（Anthropic 原生字段未映射 / OpenAI 兼容层不报缓存）](openai-compat-proxy-cache-hit-always-zero.md)
- [Anthropic 协议网关返回 401（网关只认 Authorization: Bearer）或直接拒绝 pi 内核](anthropic-gateway-401-bearer-auth.md)
- [edit 报 Could not find ...（oldText 与文件字符漂移，不是中文/CRLF 的问题；容错与诊断均已落地）](edit-not-found-oldtext-drift.md)

### 工具链
- [npm registry 证书过期导致 npx 失败](npm-registry-cert-expired.md)

### 构建/发布
- [packages/ai 构建报 TS2307（models.dev provider key 改名删掉生成 shard）](models-dev-改名删-shard-构建失败.md)

## 沉淀路径

修好一个反复出现的坑后，把剧本写进对应域文件，并在根 AGENTS.md 的 Self-Evolution 里声明更新了哪个剧本。
