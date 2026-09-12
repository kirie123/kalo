# 从 UI 建的模型不思考 / 读不到图 / 输出被截短 / 手工字段被抹

## 症状

在桌面端「添加模型 / 编辑模型」里配好 provider，能正常对话，但：

- 模型从不思考（`settings.json` 里 `defaultThinkingLevel: high` 像是没生效）；
- 粘贴截图，模型回答「无法读取到图片」；
- 长回答或长代码提前断掉；
- 手改 `models.json` 加的字段（如 `authHeader`）在 UI 里编辑一次后消失，随后报 401。

## 快速判别

```bash
pi --list-models
# provider  model              context  max-out  thinking  images
# pz        claude-opus-5      200K     16.4K    no        no     ← 命中：三个能力全缺
```

`thinking` / `images` 为 `no`、`max-out` 为 `16.4K`（引擎默认），基本就是本文。

## 根因

`ProviderEditModal` 保存时只写 `id` + `contextWindow`，并用**一条全新的 provider 对象**覆盖旧条目。
引擎 schema（`model-config.ts:ModelDefinitionSchema`）里其余字段在 `provider-composer.ts:modelFromJson()` 落到默认值：

```ts
reasoning: definition.reasoning ?? false,     // → 不发 thinking 块
input:     (definition.input ?? ["text"]),    // → 图片被换成占位符
maxTokens: definition.maxTokens ?? 16384,     // → 输出上限 16K
```

而「整条重建」会让 provider 级未被表单管理的字段（`authHeader` / `headers` / `name` / `oauth` /
`modelOverrides`）在保存时被丢掉。

## 修复（0.6.x 起）

保存改为**合并**：以盘上既有条目为底，只覆盖表单管理的字段（`baseUrl` / `api` / `apiKey` /
`authHeader` / `compat` / `models`），模型条目同样保留未管理字段（`name` / `cost` / `samplingParams`）。
表单新增四个开关：

- 模型支持思考（reasoning）
- 模型支持图片输入（vision）
- 最大输出（K）——留空用引擎默认
- 用 `Authorization: Bearer` 发送密钥

开关按 provider 共享：一个 provider 下所有模型统一写入。若既有模型取值不一致，开关显示为未勾选并提示
「当前模型取值不一致，保存后统一写入」。

写入逻辑在 `kalo-desktop/src/lib/provider-config.ts`（纯函数 + `provider-config.test.ts`），
组件只负责取值与渲染。

## 手工修（不改代码，或版本较旧时）

在 `~/.kalo/agent/models.json` 直接给模型补字段：

```json
{
  "models": [
    {
      "id": "claude-opus-5",
      "contextWindow": 200000,
      "maxTokens": 64000,
      "reasoning": true,
      "input": ["text", "image"]
    }
  ]
}
```

改完**新开会话**（引擎只在 spawn 时读 `models.json`）。注意：0.6.x 之前的版本用 UI 编辑该 provider
会把 `authHeader` 等字段抹掉，所以手工补完就先别用弹窗编辑它。

## 验证

```bash
pi --list-models                       # 三列应为 64K / yes / yes
pi --print --no-session --model pz/claude-opus-5 --thinking high --mode json "1+1" \
  | grep -c thinking_start             # ≥1 说明 thinking 真的发出去了
```

图片能力要用**内容已知**的图验证（见 `custom-provider-image-input.md`），不要只看回答像不像。
